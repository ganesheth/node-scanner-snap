#!/usr/bin/env node

const os = require('os');
const LOGGING_LEVELS = {
  FATAL: 0,
  ERROR: 1,
  DEBUG: 3,
  INFO: 2
};

const APP_STATE_RUNNING = 'running';
const APP_STATE_STOPPING = 'stopping';
const SEND_GATEWAY_CONNECTED = 'GATEWAY_CONNECTED';
const SEND_DEVICE_CONNECTED = 'DEVICE_CONNECTED';

const DISCOVER_RESTART_TIMEOUT = 5000; // XXX: Workaround for noble-device issue
const APPLICATION_START_TIMEOUT = 5000; // XXX: Wait HCI devices on system startup

let dataTransmissionTaskId = null;

let applicationState = APP_STATE_RUNNING;
let config = {};
let Noble = null;

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

//------------------------------------

const startDiscover = (appConfig) => {
  noble.on('stateChange', function(state) {
    if (state === 'poweredOn') {
      noble.startScanning();
    } else {
      noble.stopScanning();
    }
  });

  noble.on('discover', function(peripheral) {
    log('peripheral discovered (' + peripheral.id +
                ' with address <' + peripheral.address +  ', ' + peripheral.addressType + '>,' +
                ' connectable ' + peripheral.connectable + ',' +
                ' RSSI ' + peripheral.rssi + ':');
    log('\thello my local name is:');
    log('\t\t' + peripheral.advertisement.localName);
    log('\tcan I interest you in any of the following advertised services:');
    log('\t\t' + JSON.stringify(peripheral.advertisement.serviceUuids));
  
    var serviceData = peripheral.advertisement.serviceData;
    if (serviceData && serviceData.length) {
      log('\there is my service data:');
      for (var i in serviceData) {
        log('\t\t' + JSON.stringify(serviceData[i].uuid) + ': ' + JSON.stringify(serviceData[i].data.toString('hex')));
      }
    }
    if (peripheral.advertisement.manufacturerData) {
      log('\there is my manufacturer data:');
      log('\t\t' + JSON.stringify(peripheral.advertisement.manufacturerData.toString('hex')));
    }
    if (peripheral.advertisement.txPowerLevel !== undefined) {
      log('\tmy TX power level is:');
      log('\t\t' + peripheral.advertisement.txPowerLevel);
    }
  
    log();
  });
};

const stopDiscover = (disconnected) => {
  log('Stop Discovery Task ...');
  noble.stopScanning();
};
// App Utils
// ==========

const start = (appConfig) => {
  log('Starting with Config: ', appConfig, LOGGING_LEVELS.INFO);
  startDiscover(appConfig);
};

const stop = () => {
  if (applicationState === APP_STATE_STOPPING) return;
  applicationState = APP_STATE_STOPPING;
  log('Stopping ...');
  stopDiscover();
};

const init = () => {
  config = loadConfig();
  log('Initialize ...');
  // Setup noble lib
  process.env.NOBLE_HCI_DEVICE_ID = config.ble.hciDeviceNum;
  Noble = require('noble');
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
