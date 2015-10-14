'use strict';

const util = require('util');
const EventEmitter = require('events');
const _ = require('underscore');

const AdapterState = require('./adapterState');
const Device = require('./device');

// No caching of devices
// Do cache service database

class Adapter extends EventEmitter {
    constructor(bleDriver, instanceId, port) {
        super();
        this._bleDriver = bleDriver;
        this._instanceId = instanceId;
        this._adapterState = new AdapterState(instanceId, port);

        this._devices = {};
    }

    // Get the instance id
    get instanceId() {
        return this._instanceId;
    }

    _changeAdapterState(changingStates, emitOnChange) {
        let changed = false;

        _.each(changingStates, (value, state) => {
            const previousState = this._adapterState[state];

            if (previousState !== value) {
                this._adapterState[state] = value;
                changed = true;
            }
        });

        if (emitOnChange && changed) {
            this.emit('adapterStateChanged', this._adapterState);
        }
    }

    _changeDeviceState(device, changingStates, emitOnChange) {
        let changed = false;

        _.each(changingStates, (value, state) => {
            const previousState = device[state];

            if (state === 'uuids') {

            }

            if (previousState !== value) {
                device[state] = value;
                changed = true;
            }
        });

        // TODO: Do we want emit deviceChanged events? Should the device be sent with the event?
        if (emitOnChange && changed) {
            this.emit('deviceChanged', device);
        }
    }

    // options = { baudRate: x, parity: x, flowControl: x }
    // Callback signature function(err) {}
    open(options, callback) {
        this._changeAdapterState({baudRate: options.baudRate, parity: options.parity, flowControl: options.flowControl});

        // options.eventInterval = options.eventInterval;
        options.logCallback = this._logCallback;
        options.eventCallback = this._eventCallback;

        this._bleDriver.open(this._adapterState.port, options, err => {
            if(err) {
                // TODO: will adapter still be available if the call fails?
                this.emit('error', `Error occurred opening serial port: ${err}`);
            } else {
                this._changeAdapterState({available: true});
            }

            callback(err);
            return;
        });
    }

    // Callback signature function(err) {}
    close(callback) {
        // TODO: Fix when function has callback
        // TODO: how to call the callback? timer?
        this._bleDriver.close();

        this._changeAdapterState({available: false});
    }

    // TODO: log callback function declared here or in open call?;
    _logCallback(severity, message) {
        if (severity > 0) {
            console.log('log: ' + severity + ', ' + message);
        }
    }

    // TODO: event callback function declared here or in open call?;
    _eventCallback(eventArray) {
        console.log("eventArray length: " + eventArray.length);

        eventArray.forEach(event => {
            switch(event.id){
                case this._bleDriver.BLE_GAP_EVT_CONNECTED:
                    // TODO: Update device with connection handle
                    // TODO: Should 'deviceConnected' event emit the updated device?
                    this.emit('deviceConnected');
                    break;
                case this._bleDriver.BLE_GAP_EVT_DISCONNECTED:
                    // TODO: Handle disconnect event
                    this.emit('deviceDisconnected');
                    break;
                case this._bleDriver.BLE_GAP_EVT_CONN_PARAM_UPDATE:
                /*
                case this._bleDriver.BLE_GAP_EVT_SEC_PARAMS_REQUEST:
                case this._bleDriver.BLE_GAP_EVT_SEC_INFO_REQUEST:
                case this._bleDriver.BLE_GAP_EVT_PASSKEY_DISPLAY:
                case this._bleDriver.BLE_GAP_EVT_AUTH_KEY_REQUEST:
                case this._bleDriver.BLE_GAP_EVT_AUTH_STATUS:
                case this._bleDriver.BLE_GAP_EVT_CONN_SEC_UPDATE:
                */
                case this._bleDriver.BLE_GAP_EVT_TIMEOUT:
                case this._bleDriver.BLE_GAP_EVT_RSSI_CHANGED:
                case this._bleDriver.BLE_GAP_EVT_ADV_REPORT:
                    this._parseAdvertismentReport(event);
                    break;
                /*
                case this._bleDriver.BLE_GAP_EVT_SEC_REQUEST:
                */
                case this._bleDriver.BLE_GAP_EVT_CONN_PARAM_UPDATE_REQUEST:
                case this._bleDriver.BLE_GAP_EVT_SCAN_REQ_REPORT:
                    console.log(`Unsupported GAP event received from SoftDevice: ${event.id} - ${event.name}`);
                    break;
                case this._bleDriver.BLE_GATTC_EVT_PRIM_SRVC_DISC_RSP:
                case this._bleDriver.BLE_GATTC_EVT_REL_DISC_RSP:
                case this._bleDriver.BLE_GATTC_EVT_CHAR_DISC_RSP:
                case this._bleDriver.BLE_GATTC_EVT_DESC_DISC_RSP:
                case this._bleDriver.BLE_GATTC_EVT_CHAR_VAL_BY_UUID_READ_RSP:
                case this._bleDriver.BLE_GATTC_EVT_READ_RSP:
                case this._bleDriver.BLE_GATTC_EVT_CHAR_VALS_READ_RSP:
                case this._bleDriver.BLE_GATTC_EVT_WRITE_RSP:
                case this._bleDriver.BLE_GATTC_EVT_HVX:
                case this._bleDriver.BLE_GATTC_EVT_TIMEOUT:
                    console.log(`Unsupported GATTC event received from SoftDevice: ${event.id} - ${event.name}`);
                    break;
                case this._bleDriver.BLE_GATTS_EVT_WRITE:
                case this._bleDriver.BLE_GATTS_EVT_RW_AUTHORIZE_REQUEST:
                case this._bleDriver.BLE_GATTS_EVT_SYS_ATTR_MISSING:
                case this._bleDriver.BLE_GATTS_EVT_HVC:
                case this._bleDriver.BLE_GATTS_EVT_SC_CONFIRM:
                case this._bleDriver.BLE_GATTS_EVT_TIMEOUT:
                    console.log(`Unsupported GATTS event received from SoftDevice: ${event.id} - ${event.name}`);
                    break;
                default:
                    console.log(`Unsupported event received from SoftDevice: ${event.id} - ${event.name}`);
                    break;
            }
        });
    }

    _parseAdvertismentReport(event) {
        // TODO: Check address type?
        // TODO: Store raw adv_data?
        const address = event.peer_addr.address;
        const changingStates = {};
        let uuids = [];

        if (event.data.BLE_GAP_AD_TYPE_LONG_LOCAL_NAME) {
            changingStates.name = event.data.BLE_GAP_AD_TYPE_LONG_LOCAL_NAME;
        } else if (event.data.BLE_GAP_AD_TYPE_SHORT_LOCAL_NAME) {
            changingStates.name = event.data.BLE_GAP_AD_TYPE_SHORT_LOCAL_NAME;
        }

        // TODO: Translate from uuid to service names?
        // TODO: Find out how to figure out changes for uuids? Keep uuids separate in adv report and scan response lists?
        if (event.data.BLE_GAP_AD_TYPE_16BIT_SERVICE_UUID_MORE_AVAILABLE) {
            uuids = uuids.concat(event.data.BLE_GAP_AD_TYPE_16BIT_SERVICE_UUID_MORE_AVAILABLE);
        }

        if (event.data.BLE_GAP_AD_TYPE_16BIT_SERVICE_UUID_COMPLETE) {
            uuids = uuids.concat(event.data.BLE_GAP_AD_TYPE_16BIT_SERVICE_UUID_COMPLETE);
        }

        if (event.data.BLE_GAP_AD_TYPE_32BIT_SERVICE_UUID_MORE_AVAILABLE) {
            uuids = uuids.concat(event.data.BLE_GAP_AD_TYPE_32BIT_SERVICE_UUID_MORE_AVAILABLE);
        }

        if (event.data.BLE_GAP_AD_TYPE_32BIT_SERVICE_UUID_COMPLETE) {
            uuids = uuids.concat(event.data.BLE_GAP_AD_TYPE_32BIT_SERVICE_UUID_COMPLETE);
        }

        if (event.data.BLE_GAP_AD_TYPE_128BIT_SERVICE_UUID_MORE_AVAILABLE) {
            uuids = uuids.concat(event.data.BLE_GAP_AD_TYPE_128BIT_SERVICE_UUID_MORE_AVAILABLE);
        }

        if (event.data.BLE_GAP_AD_TYPE_128BIT_SERVICE_UUID_COMPLETE) {
            uuids = uuids.concat(event.data.BLE_GAP_AD_TYPE_128BIT_SERVICE_UUID_COMPLETE);
        }

        if (event.data.BLE_GAP_AD_TYPE_TX_POWER_LEVEL) {
            changingStates.txPower = event.data.BLE_GAP_AD_TYPE_TX_POWER_LEVEL;
        }

        changingStates.rssi = event.rssi;

        let device = this.getDevice(address);

        if (device) {
            this._changeDeviceState(device, changingStates);
        } else {
            const emitOnChange = false;
            device = new Device(address, changingStates.name, 'peripheral', uuids);
            this._changeDeviceState(device, changingStates, emitOnChange);
            this._devices[address] = device;
        }
    }

    // Callback signature function(err, state) {}
    getAdapterState(callback) {
        // TODO: update information
        // TODO: Figure out if calls should be nested or have some magic variable checks

        if (this._firmwareVersion) {
            return this._firmwareVersion;
        }

        this._bleDriver.get_version((version, err) => {
            if (err) {
                this.emit('error', 'Failed to retrieve softdevice firmwareVersion');
            } else {
                this._adapterState.firmwareVersion = version;
            }
        });


        this._bleDriver.gap_get_device_name((name, err) => {
            if (err) {
                // TODO: logging?
                return;
            }

            this._name = name;
        });


        this._bleDriver.gap_get_address((address, err) => {
            if (err) {
                // TODO: logging?
                return;
            }
        });

        return this._adapterState;
    }

    // Set GAP related information
    setName(name, callback) {
        this._bleDriver.gap_set_device_name({sm: 0, lv: 0}, name, err => {
            if (err) {
                this.emit('error', 'Failed to set name to adapter');
            } else if (this._adapterState.name !== name) {
                this._adapterState.name = name;

                this._changeAdapterState({name: name});
            }

            callback(err);
        });
    }

    _getAddressStruct(address, type) {
        return {address: address, type: type};
    }

    setAddress(address, type, callback) {
        const cycleMode = this._bleDriver.BLE_GAP_ADDR_CYCLE_MODE_NONE;
        // TODO: if privacy is active use this._bleDriver.BLE_GAP_ADDR_CYCLE_MODE_AUTO?

        let addressStruct = this._getAddressStruct(address, type);

        this._bleDriver.gap_set_address(cycleMode, addressStruct, err => {
            if (err) {
                this.emit('error', 'Failed to set address');
            } else if (this._adapterState.address !== address) {
                // TODO: adapterState address include type?
                this._changeAdapterState({address: address});
            }

            callback(err);
        });
    }

    // eventName:
    // 'error', 'adapterStateChange'
    // 'deviceConnected', 'deviceDisconnected' // Role central
    // 'serviceAdded', 'serviceRemoved', 'serviceChanged' // refresh service database. TODO: relevant for GATTS role ?
    // 'characteristicValueChanged', 'descriptorValueChanged' // changed == value received, changed or not
    // 'connParamUpdateRequest', 'connParamUpdate'
    // 'insufficentPrivileges',
    // 'deviceDiscovered' // Callback signature function(device) {}
    // 'securityRequest', 'securityParameters'
    /*
    on(eventName, callback) {

    }
    */

    // Get connected device/devices

    // Callback signature function(devices : Device[]) {}
    getDevices(callback) {

    }

    // Callback signature function(device)
    getDevice(deviceAddress, callback) {

    }

    // Only for central

    // options: { active: x, interval: x, window: x timeout: x TODO: other params}. Callback signature function(err).
    startScan(options, callback) {
        this._bleDriver.start_scan(options, err => {
            if (err) {
                this.emit('error', 'Error occured when starting scan');
            } else {
                this._changeAdapterState({scanning: true});
            }

            callback(err);
        });
    }

    // Callback signature function(err)
    stopScan(callback) {
        // TODO: check if adapterState is in scanning mode?

        this._bleDriver.stop_scan(err => {
            if (err) {
                // TODO: probably is state already set to false, but should we make sure? if yes, emit adapterStateChanged?
                this.emit('error', 'Error occured when stopping scanning');
            } else {
                this._changeAdapterState({scanning: false});
            }

            callback(err);
        });
    }

    // options: scanParams, connParams, Callback signature function(err) {}. Do not start service discovery. Err if connection timed out, +++
    connect(deviceAddress, options, callback) {
        this._bleDriver.gap_connect(deviceAddress, options.scanParams, options.connParams, err => {
            if (err) {
                this.emit('error', `Could not connect to ${deviceAddress}`);
            } else {
                this._changeAdapterState({scanning: false, connecting: true});
            }

            callback(err);
        });
    }

    // Callback signature function() {}
    cancelConnect(callback) {
        this._bleDriver.gap_cancel_connect(err => {
            if (err) {
                // TODO: log more
                this.emit('error', 'Error occured when canceling connection');
            } else {
                this._changeAdapterState({connecting: false});
            }

            callback(err);
        });
    }

    // Role peripheral
    /**
     * @brief [brief description]
     * @details [long description]
     *
     * @param sendName If name shall be sent (from setName)
     * @param adveritisingData
     * // { short_name: true/false/other name,
     * long_name: true/false/other name
     * tx_power_level: x,
     * local_services: [serviceA, serviceB] // could be UUID text strings (array),
     * service_solicitation:
     * and more....
     * }
     * @param scanResponseData
     * { name: true/false/other name},
     * and more...
     * @param options
     * { interval: x, timeout: x, channel_map: [35]  optional, if nothing, use all }
     *
     */

    // Enable the client role and starts advertising

    _getAdvertismentParams(type, addressStruct, filterPolicy, interval, timeout) {
        // TODO: as parameters?
        const whitelistStruct = null;
        const channelMaskStruct = null;

        return {type: type, peer_addr: addressStruct, fp: filterPolicy, whitelist: whitelistStruct,
                interval: interval, timeout:timeout, channelMask: channelMaskStruct};
    }

    // name given from setName. Callback function signature: function(err) {}
    startAdvertising(advertisingData, scanResponseData, options, callback) {
        const type = this._bleDriver.BLE_GAP_ADV_TYPE_ADV_IND;
        const addressStruct = this._getAddressStruct(options.address, options.addressType);
        const filterPolicy = this._bleDriver.BLE_GAP_ADV_FP_ANY;
        const interval = options.interval;
        const timeout = options.timeout;

        //TODO: need to parse advertising and scanData and convert to byte array?
        this._bleDriver.gap_set_adv_data(advertisingData, scanResponseData);

        const advertismentParamsStruct = this._getAdvertismentParams(type, addressStruct, filterPolicy, interval, timeout);

        this._bleDriver.gap_start_advertising(advertismentParamsStruct, err => {
            if (err) {
                console.log('Failed to start advertising');
            } else {
                this._adapterState.scanning = true;
                this.emit('adapterStateChanged', this._adapterState);
            }

            callback(err);
        });
    }

    // Callback function signature: function(err) {}
    stopAdvertising(callback) {
        this._bleDriver.gap_stop_advertising(err => {
            if (err) {
                // TODO: probably is state already set to false, but should we make sure? if ys, emit adapterStateChanged?
                console.log('Error occured when stopping advertising');
            } else {
                this._changeAdapterState({advertising: false});
            }

            callback(err);
        });
    }

    // Central/peripheral

    disconnect(deviceInstanceId, callback) {
        const device = this.getDevice(deviceInstanceId);
        const hciStatusCode = this._bleDriver.BLE_HCI_REMOTE_USER_TERMINATED_CONNECTION;
        this._bleDriver.disconnect(device.connectionHandle, hciStatusCode, err => {
            if (err) {
                this.emit('error', 'Failed to disconnect');
            } else {
                // TODO: remove from device list when disconnect event received
                this._changeAdapterState({connected: false});
            }

            callback(err);
        });
    }

    _getConnectionUpdateParams(options) {
        return {min_conn_interval: options.minConnectionInterval, max_conn_interval: options.maxConnInterval,
                slave_latency: options.slaveLatency, conn_sup_timeout: options.connectionSupervisionTimeout};
    }

    // options: connParams, callback signature function(err) {} returns true/false
    updateConnParams(deviceInstanceId, options, callback) {
        const connectionHandle = this.getDevice(deviceInstanceId).connectionHandle;
        const connectionParamsStruct = this._getConnectionUpdateParams(options);
        this._bleDriver.gap_update_connection_parameters(connectionHandle, connectionParamsStruct, err => {
            if (err) {
                this.emit('error', 'Failed to update connection parameters');
            }

            callback(err);
        });
    }

    // Central role

    // callback signature function(err) {}
    rejectConnParams(deviceInstanceId, callback) {
        const connectionHandle = this.getDevice(deviceInstanceId).connectionHandle;

        // TODO: Does the AddOn support undefined second parameter?
        this._bleDriver.gap_update_connection_parameters(connectionHandle, null, err => {
            if (err) {
                this.emit('error', 'Failed to reject connection parameters');
            }

            callback(err);
        });
    }

    // Bonding (when in central role)

    setCapabilities(keyboard, screen) {
        this._keyboard = keyboard;
        this._screen = screen;
    }

    setLongTermKey(deviceAddress, ltk) {

    }

    // TODO: clarify when needed
    setEDIV(ediv, rnd) {

    }

    // Callback signature function(err) {}
    pair(deviceAddress, mitm, passkey, callback) {

    }

    // TODO: check if sending paramters from event is OK
    // Callback signature function(err) {}
    encrypt(deviceAddress, callback) {

    }

    // Bonding (peripheral role)

    // GATTS

    // Array of services
    setServices(services) {

    }

    // GATTS/GATTC

    // Callback signature function(err, service) {}
    getService(serviceInstanceId, callback) {
        // TODO: iterate over all devices to find service with correct serviceInstanceId?
        // TODO: split up serviceInstaceId to find deviceInstanceId?
    }

    // Callback signature function(err, services) {}. If deviceInstanceId is local, local database (GATTS)
    getServices(deviceInstanceId, callback) {

    }


    // Callback signature function(err, characteristic) {}
    getCharacteristic(characteristicId, callback) {

    }

    // Callback signature function(err, characteristics) {}
    getCharacteristics(serviceId, callback) {

    }


    // Callback signature function(err, descriptor) {}
    getDescriptor(descriptorId, callback) {

    }

    // Callback signature function(err, descriptors) {}
    getDescriptors(characteristicId, callback) {

    }


    // Callback signature function(err) {}
    readCharacteristicsValue(characteristicId, offset, callback) {

    }

    // Callback signature function(err) {}  ack: require acknowledge from device, irrelevant in GATTS role. options: {ack, long, offset}
    writeCharacteristicsValue(characteristicId, value, options, callback) {

    }


    // Callback signature function(err) {}
    readDescriptorValue(descriptorId, offset, callback) {

    }

    // Callback signature function(err) {}, callback will not be called unti ack is received. options: {ack, long, offset}
    writeDescriptorValue(descriptorId, value, options, callback) {

    }

    // Only for GATTC role

    // Callback signature function(err) {}, ack: require all notifications to ack, callback will not be called until ack is received
    startCharacteristicsNotifications(characteristicId, ack_notifications, callback) {

    }

    // Callback signature function(err) {}
    stopCharacteristicsNotifications(characteristicId, callback) {

    }
}
module.exports = Adapter;