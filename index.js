#!/usr/bin/env node

const os = require('os');
const MQTT = require('mqtt');

const LOGGING_LEVELS = {
  FATAL: 0,
  ERROR: 1,
  DEBUG: 3,
  INFO: 2
};

let Thingy = null;

const APP_STATE_RUNNING = 'running';
const APP_STATE_STOPPING = 'stopping';
const SEND_GATEWAY_CONNECTED = 'GATEWAY_CONNECTED';
const SEND_DEVICE_CONNECTED = 'DEVICE_CONNECTED';

const DISCOVER_RESTART_TIMEOUT = 5000; // XXX: Workaround for noble-device issue
const APPLICATION_START_TIMEOUT = 5000; // XXX: Wait HCI devices on system startup

let dataTransmissionTaskId = null;

let applicationState = APP_STATE_RUNNING;

let mqttClient = null;
let connectedThingy = null;
const thingyState = {
  accel: {
    x: 0,
    y: 0,
    z: 0
  },
  button: false
};
let config = {};

// Commons
// ==========

const loadConfig = () => {
  const c = require('./config');
  let { topic } = c.mqtt;
  topic = topic.replace('{hostname}', os.hostname());
  c.mqtt.topic = topic;
  return c;
};

const log = (msg, data = '', level = LOGGING_LEVELS.DEBUG) => {
  const appLoggingLevel = LOGGING_LEVELS[config.app.loggingLevel];
  if (level <= LOGGING_LEVELS.ERROR) {
    console.error(msg, data);
  }
  else if (level <= appLoggingLevel) {
    console.log(`${msg}`, data);
  }
};

// Broker Utils
// ==========

const brokerDisconnect = () => {
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }
};

const brokerConnect = (mqttConfig) => {
  const mqttAddr = `${mqttConfig.host}:${mqttConfig.port}`;
  log(`Connecting to: ${mqttAddr}`);

  const connectionProblemsHandler = (err) => {
    if (err) {
      log('Connection problem, disconnecting ...', err, LOGGING_LEVELS.ERROR);
    }
  };
  log('new MQTT client creation ...');
  mqttClient = MQTT.connect({
    protocol: 'mqtt',
    host: mqttConfig.host,
    port: mqttConfig.port,
    reconnecting: true
  });

  mqttClient.on('connect', () => {
    log(`Successfully connected to: ${mqttAddr}`, '', LOGGING_LEVELS.INFO);
  });

  mqttClient.on('close', connectionProblemsHandler);
  mqttClient.on('error', connectionProblemsHandler);
  mqttClient.on('end', connectionProblemsHandler);
  mqttClient.on('offline', connectionProblemsHandler);
};

// Thingy Utils
// ==========

const disconnectThingy = (disconnected) => {
  if (!disconnected && connectedThingy) {
    connectedThingy.disconnect();
  }
  connectedThingy = null;
};

const macToId = mac => (mac.toLowerCase().replace(new RegExp(':', 'g'), ''));

const startDiscoverThingyTask = (appConfig) => {
  const handleDiscover = (thingy) => {
    if (!connectedThingy) {
      connectAndSetupThingy(thingy); // eslint-disable-line no-use-before-define
    }
  };
  log('Start Discovery Task ...');
  const id = macToId(appConfig.ble.deviceMAC);
  Thingy.discoverWithFilter((device) => {
    log(`Discover: ${device.id} target: ${id}`, '', LOGGING_LEVELS.INFO);
    if (id === '*') return true;
    return id === device.id;
  }, handleDiscover);
};

const stopDiscoverThingyTask = (disconnected) => {
  log('Stop Discovery Task ...');
  Thingy.stopDiscover((err) => {
    if (err) {
      log('Connection/Setup problem, disconnecting ...', err, LOGGING_LEVELS.ERROR);
    }
  });
  disconnectThingy(disconnected);
};

const restartDiscoverThingyTask = (disconnected) => {
  const appConfig = loadConfig();
  stopDiscoverThingyTask(disconnected);
  setTimeout(() => {
    startDiscoverThingyTask(appConfig);
  }, DISCOVER_RESTART_TIMEOUT);
};

const connectAndSetupThingy = (thingy) => {
  const handleError = (error) => {
    if (error) {
      log('Connection/Setup problem, disconnecting ...', error, LOGGING_LEVELS.ERROR);
      restartDiscoverThingyTask();
    }
  };

  log('Connecting to the Thingy:52', thingy.id, LOGGING_LEVELS.INFO);
  thingy.connectAndSetUp((error) => {
    if (error) handleError(error);
    else {
      // User Interface
      thingy.led_breathe({
        color: 2,
        intensity: 100,
        delay: 1000
      }, handleError);
      thingy.button_enable(handleError);
      thingy.on('buttonNotif', (state) => {
        if (state === 'Pressed') {
          thingyState.button = true;
        }
      });
      // Sensors
      thingy.raw_enable(handleError);
      thingy.on('rawNotif', (rawData) => {
        thingyState.accel.x = rawData.accelerometer.x;
        thingyState.accel.y = rawData.accelerometer.y;
        thingyState.accel.z = rawData.accelerometer.z;
      });
      // Service
      thingy.on('disconnect', () => {
        log('Thingy:52 disconnected', LOGGING_LEVELS.INFO);
        restartDiscoverThingyTask(true);
      });
      connectedThingy = thingy;
      log('Successfully connected to ', thingy.id, LOGGING_LEVELS.INFO);
    }
  });
};

// Transmission Utils
// ==========

const send = (appConfig, payload, status) => {
  const msg = JSON.stringify({
    status,
    timestamp: Math.round((new Date()).getTime() / 1000),
    payload
  });
  mqttClient.publish(appConfig.topic, msg);
  log(`Publish to ${appConfig.topic} ${msg}`);
};

const sendDeviceState = (appConfig) => {
  send(appConfig, thingyState, SEND_DEVICE_CONNECTED);
  thingyState.button = false;
};

const sendHealth = (appConfig) => {
  send(appConfig, null, SEND_GATEWAY_CONNECTED);
};

const startSendingTask = (appConfig) => {
  log('Start Sending Task ...');
  return setInterval(() => {
    if (mqttClient) {
      if (connectedThingy) {
        sendDeviceState(appConfig.mqtt);
      }
      else {
        sendHealth(appConfig.mqtt);
      }
    }
  }, appConfig.app.sendInterval);
};

const stopSendingTask = () => {
  log('Stop Sending Task ...');
  clearInterval(dataTransmissionTaskId);
};

// App Utils
// ==========

const start = (appConfig) => {
  log('Starting with Config: ', appConfig, LOGGING_LEVELS.INFO);

  brokerConnect(appConfig.mqtt);
  startDiscoverThingyTask(appConfig);
  dataTransmissionTaskId = startSendingTask(appConfig);
};

const stop = () => {
  if (applicationState === APP_STATE_STOPPING) return;
  applicationState = APP_STATE_STOPPING;
  log('Stopping ...');
  stopSendingTask();
  brokerDisconnect();
  stopDiscoverThingyTask();
};

const init = () => {
  config = loadConfig();
  log('Initialize ...');
  // Setup noble lib
  process.env.NOBLE_HCI_DEVICE_ID = config.ble.hciDeviceNum;
  Thingy = require('thingy52');
  // Set exit handlers
  process.on('exit', () => {
    stop();
  });
  process.on('uncaughtException', (err) => {
    log('uncaughtException:', err, LOGGING_LEVELS.FATAL);
    try {
      stop();
    }
    catch (stopErr) {
      log('Error while stop:', stopErr, LOGGING_LEVELS.FATAL);
    }
    finally {
      process.exit(-1);
    }
  });
  return config;
};

// Application
// ==========
init();
setTimeout(() => {
  start(config);
}, APPLICATION_START_TIMEOUT);
