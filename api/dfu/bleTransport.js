/* Copyright (c) 2016, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *   1. Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 *
 *   2. Redistributions in binary form, except as embedded into a Nordic
 *   Semiconductor ASA integrated circuit in a product or a software update for
 *   such product, must reproduce the above copyright notice, this list of
 *   conditions and the following disclaimer in the documentation and/or other
 *   materials provided with the distribution.
 *
 *   3. Neither the name of Nordic Semiconductor ASA nor the names of its
 *   contributors may be used to endorse or promote products derived from this
 *   software without specific prior written permission.
 *
 *   4. This software, with or without modification, must only be used with a
 *   Nordic Semiconductor ASA integrated circuit.
 *
 *   5. Any software provided in binary form under this license must not be
 *   reverse engineered, decompiled, modified and/or disassembled.
 *
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
 * GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
 * OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

const logLevel = require('../util/logLevel');
const ObjectWriter = require('./bleTransport/objectWriter');
const DeviceInfoService = require('./bleTransport/deviceInfoService');
const ControlPointService = require('./bleTransport/controlPointService');
const InitPacketState = require('./dfuModels').InitPacketState;
const FirmwareState = require('./dfuModels').FirmwareState;
const ObjectType = require('./dfuConstants').ObjectType;
const ErrorCode = require('./dfuConstants').ErrorCode;
const ResultCode = require('./dfuConstants').ResultCode;
const createError = require('./dfuConstants').createError;
const EventEmitter = require('events');

const MAX_RETRIES = 3;

const DFU_SERVICE_UUID = 'FE59';
const DFU_CONTROL_POINT_UUID = '8EC90001F3154F609FB8838830DAEA50';
const DFU_PACKET_UUID = '8EC90002F3154F609FB8838830DAEA50';

const DEFAULT_CONNECTION_PARAMS = {
    min_conn_interval: 7.5,
    max_conn_interval: 7.5,
    slave_latency: 0,
    conn_sup_timeout: 4000,
};
const DEFAULT_SCAN_PARAMS = {
    active: true,
    interval: 100,
    window: 50,
    timeout: 20,
};
const ATT_WRITE_COMMAND_HEADER_SIZE = 3;
const MAX_SUPPORTED_MTU_SIZE = 247;
const DEFAULT_PRN = 0;


/**
 * Implementation of Secure DFU transport according to the following specification:
 * https://infocenter.nordicsemi.com/index.jsp?topic=%2Fcom.nordic.infocenter.sdk5.v12.0.0%2Flib_dfu_transport_ble.html
 *
 * This transport requires an open adapter instance, and the BLE address for the
 * target device.
 *
 * After using init() for initialization, sendInitPacket() and sendFirmware() can
 * be invoked to perform DFU. The target disconnects after sending firmware is
 * finished. Waiting for the disconnect is done through waitForDisconnection().
 * When done with the transport, destroy() should be invoked to free up resources.
 *
 * In the future, other DFU transports may be needed. In that case it is probably
 * a good idea to introduce a transport factory that is responsible for creating
 * transports. The transports must then implement the same public methods and events.
 */
class DfuTransport extends EventEmitter {

    /**
     * Creates a DfuTransport by using the supplied transport parameters.
     *
     * Available transport parameters:
     * - adapter:           An instance of adapter (required)
     * - targetAddress:     The target address to connect to (required)
     * - targetAddressType: The target address type (required)
     * - prnValue:          Packet receipt notification number (optional)
     * - mtuSize:           Maximum transmission unit number (optional)
     *
     * @param transportParameters configuration parameters
     */
    constructor(transportParameters) {
        super();

        if (!transportParameters.adapter) {
            throw new Error('Required transport parameter "adapter" was not provided');
        }
        if (!transportParameters.targetAddress) {
            throw new Error('Required transport parameter "targetAddress" was not provided');
        }
        if (!transportParameters.targetAddressType) {
            throw new Error('Required transport parameter "targetAddressType" was not provided');
        }

        this._adapter = transportParameters.adapter;
        this._transportParameters = transportParameters;

        this._handleConnParamUpdateRequest = this._handleConnParamUpdateRequest.bind(this);
        this._adapter.on('connParamUpdateRequest', this._handleConnParamUpdateRequest);
        this._isInitialized = false;
    }

    /**
     * Initializes the transport. Connects to the target device and sets up the transport
     * according to the configured transport parameters.
     *
     * @returns Promise that resolves when initialized
     */
    init() {
        if (this._isInitialized) {
            return Promise.resolve();
        }

        const targetAddress = this._transportParameters.targetAddress;
        const targetAddressType = this._transportParameters.targetAddressType;
        const prnValue = this._transportParameters.prnValue || DEFAULT_PRN;
        const mtuSize = this._transportParameters.mtuSize || MAX_SUPPORTED_MTU_SIZE;

        this._debug(`Initializing DFU transport with targetAddress: ${targetAddress}, ` +
            `targetAddressType: ${targetAddressType}, prnValue: ${prnValue}, mtuSize: ${mtuSize}.`);

        return this._connectIfNeeded(targetAddress, targetAddressType)
            .then(device => this._getCharacteristicIds(device))
            .then(characteristicIds => {
                const controlPointId = characteristicIds.controlPointId;
                const packetId = characteristicIds.packetId;
                this._controlPointService = new ControlPointService(this._adapter, controlPointId);
                this._objectWriter = new ObjectWriter(this._adapter, controlPointId, packetId);
                this._objectWriter.on('packetWritten', progress => {
                    this._emitTransferEvent(progress.offset, progress.type);
                });
                return this._startCharacteristicsNotifications(controlPointId);
            })
            .then(() => this._setPrn(prnValue))
            .then(() => this._setMtuSize(mtuSize))
            .then(() => this._isInitialized = true);
    }

    /**
     * Destroys the transport. Removes all listeners, so that the transport can
     * be garbage collected.
     */
    destroy() {
        if (this._objectWriter) {
            this._objectWriter.removeAllListeners();
        }
        this._adapter.removeListener('connParamUpdateRequest', this._handleConnParamUpdateRequest);
    }


    /**
     * Find the DFU control point and packet characteristic IDs.
     *
     * @param device the device to find characteristic IDs for
     * @returns { controlPointId, packetId }
     * @private
     */
    _getCharacteristicIds(device) {
        const deviceInfoService = new DeviceInfoService(this._adapter, device.instanceId);
        return deviceInfoService.getCharacteristicId(DFU_SERVICE_UUID, DFU_CONTROL_POINT_UUID)
            .then(controlPointCharacteristicId => {
                return deviceInfoService.getCharacteristicId(DFU_SERVICE_UUID, DFU_PACKET_UUID)
                    .then(packetCharacteristicId => {
                        this._debug(`Found controlPointCharacteristicId: ${controlPointCharacteristicId}, ` +
                            `packetCharacteristicId: ${packetCharacteristicId}`);
                        return {
                            controlPointId: controlPointCharacteristicId,
                            packetId: packetCharacteristicId
                        };
                    });
            });
    }


    /**
     * Connect to the target device if not already connected.
     *
     * @param targetAddress the address to connect to
     * @param targetAddressType the target address type
     * @returns Promise that resolves with device when connected
     * @private
     */
    _connectIfNeeded(targetAddress, targetAddressType) {
        const device = this._getConnectedDevice(targetAddress);
        if (device) {
            return Promise.resolve(device);
        } else {
            this._debug(`Connecting to address: ${targetAddress}, type: ${targetAddressType}.`);
            return this._connect(targetAddress, targetAddressType);
        }
    }


    /**
     * Returns connected device for the given address. If there is no connected
     * device for the address, then null is returned.
     *
     * @param targetAddress the address to get connected device for
     * @returns connected device
     * @private
     */
    _getConnectedDevice(targetAddress) {
        const devices = this._adapter.getDevices();
        const deviceId = Object.keys(devices).find(deviceId => {
            return devices[deviceId].address === targetAddress;
        });
        if (deviceId && devices[deviceId].connected) {
            return devices[deviceId];
        }
        return null;
    }


    /**
     * Connect to the target device.
     *
     * @param targetAddress the address to connect to
     * @param targetAddressType the target address type
     * @returns Promise that resolves with device when connected
     * @private
     */
    _connect(targetAddress, targetAddressType) {
        const options = {
            scanParams: DEFAULT_SCAN_PARAMS,
            connParams: DEFAULT_CONNECTION_PARAMS,
        };

        const addressParams = {
            address: targetAddress,
            type: targetAddressType,
        };

        return new Promise((resolve, reject) => {
            this._adapter.connect(addressParams, options, (err, device) => {
                err ? reject(err) : resolve(device);
            });
        });
    }


    /**
     * Wait for the connection to the DFU target to break. Times out with an
     * error if the target is not disconnected within 10 seconds.
     *
     * Used to ensure that the next update does not start using the old
     * connection. Losing the connection is expected behaviour after the call
     * to sendFirmware(), as the DFU target should reset after the last
     * firmware object is successfully executed.
     *
     * @returns Promise resolving when the target device is disconnected
     */
    waitForDisconnection() {
        this._debug('Waiting for target device to disconnect.');
        const TIMEOUT_MS = 10000;

        return new Promise((resolve, reject) => {
            const connectedDevice = this._getConnectedDevice(this._transportParameters.targetAddress);
            if (!connectedDevice) {
                this._debug('Already disconnected from target device.');
                return resolve();
            }

            let timeout;
            const disconnectionHandler = device => {
                if (device.instanceId === connectedDevice.instanceId) {
                    clearTimeout(timeout);
                    this._debug('Received disconnection event for target device.');
                    this._adapter.removeListener('deviceDisconnected', disconnectionHandler);
                    resolve();
                }
            };

            timeout = setTimeout(() => {
                this._adapter.removeListener('deviceDisconnected', disconnectionHandler);
                reject(createError(ErrorCode.DISCONNECTION_TIMEOUT,
                    'Timed out when waiting for target device to disconnect.'));
            }, TIMEOUT_MS);

            this._adapter.on('deviceDisconnected', disconnectionHandler);
        });
    }


    /**
     * Sends init packet to the device. If parts of the same init packet has
     * already been sent, then the transfer is resumed.
     *
     * @param data byte array to send to the device
     * @return Promise with empty response
     */
    sendInitPacket(data) {
        this._emitInitializeEvent(ObjectType.COMMAND);
        return this.getInitPacketState(data)
            .then(state => {
                this._debug(`Sending init packet: ${state.toString()}`);
                if (state.hasResumablePartialObject) {
                    const object = state.remainingData;
                    return this._resumeWriteObject(object, ObjectType.COMMAND, state.offset, state.crc32);
                }
                return this._createAndWriteObject(state.remainingData, ObjectType.COMMAND);
            });
    }

    /**
     * Sends firmware to the device. If parts of the same firmware has already
     * been sent, then the transfer is resumed.
     *
     * @param data byte array to send to the device
     * @returns Promise with empty response
     */
    sendFirmware(data) {
        this._emitInitializeEvent(ObjectType.DATA);
        return this.getFirmwareState(data)
            .then(state => {
                this._debug(`Sending firmware: ${state.toString()}`);
                const objects = state.remainingObjects;
                if (state.hasResumablePartialObject) {
                    const object = state.remainingPartialObject;
                    return this._resumeWriteObject(object, ObjectType.DATA, state.offset, state.crc32).then(progress =>
                        this._createAndWriteObjects(objects, ObjectType.DATA, progress.offset, progress.crc32));
                }
                return this._createAndWriteObjects(objects, ObjectType.DATA, state.offset, state.crc32);
        });
    }

    /**
     * Returns the current init packet transfer state.
     *
     * @param data the complete init packet byte array
     * @returns Promise that returns an instance of InitPacketState
     */
    getInitPacketState(data) {
        return this.init()
            .then(() => this._controlPointService.selectObject(ObjectType.COMMAND))
            .then(response => {
                this._debug(`Got init packet state from target. Offset: ${response.offset}, ` +
                    `crc32: ${response.crc32}, maximumSize: ${response.maximumSize}.`);

                return new InitPacketState(data, response);
            });
    }

    /**
     * Returns the current firmware transfer state.
     *
     * @param data the complete firmware byte array
     * @returns Promise that returns an instance of FirmwareState
     */
    getFirmwareState(data) {
        return this.init()
            .then(() => this._controlPointService.selectObject(ObjectType.DATA))
            .then(response => {
                this._debug(`Got firmware state from target. Offset: ${response.offset}, ` +
                    `crc32: ${response.crc32}, maximumSize: ${response.maximumSize}.`);

                return new FirmwareState(data, response);
            });
    }

    /**
     * Specifies that the transfer in progress should be interrupted. This will
     * abort before the next packet is written, and throw an error object with
     * code ABORTED.
     */
    abort() {
        this._objectWriter.abort();
    }

    /**
     * Sets packet receipt notification (PRN) value, which specifies how many
     * packages should be sent before receiving receipt.
     *
     * @param prn the PRN value (disabled if 0)
     * @returns Promise with empty response
     * @private
     */
    _setPrn(prn) {
        return this._controlPointService.setPRN(prn)
            .then(() => this._objectWriter.setPrn(prn));
    }

    /**
     * Sets maximum transmission unit (MTU) size. This defines the size of
     * packets that are transferred to the device. Default is 20.
     *
     * @param mtuSize the MTU size
     * @private
     */
    _setMtuSize(mtuSize) {
        const targetAddress = this._transportParameters.targetAddress;
        const connectedDevice = this._getConnectedDevice(targetAddress);
        if (!connectedDevice) {
            return Promise.reject(createError(ErrorCode.ATT_MTU_ERROR, `Tried to set ATT MTU, but not ` +
                `connected to target address ${targetAddress}.`));
        }
        return new Promise((resolve, reject) => {
            this._adapter.requestAttMtu(connectedDevice.instanceId, mtuSize, (error, acceptedMtu) => {
                if (error) {
                    reject(createError(ErrorCode.ATT_MTU_ERROR, `Tried to set ATT MTU ${mtuSize} for ` +
                        `target address ${targetAddress}, but got error: ${error.message}`));
                } else if (!acceptedMtu) {
                    reject(createError(ErrorCode.ATT_MTU_ERROR, `Tried to set ATT MTU ${mtuSize} for ` +
                        `target address ${targetAddress}, but got invalid ATT MTU back: ${acceptedMtu}`));
                } else {
                    this._debug(`Setting MTU to ${acceptedMtu} (MTU of ${mtuSize} was requested)`);
                    this._objectWriter.setMtuSize(acceptedMtu - ATT_WRITE_COMMAND_HEADER_SIZE);
                    resolve();
                }
            });
        });
    }


    /**
     * Instructs the device to start notifying about changes to the given characteristic id.
     *
     * @returns Promise with empty response
     * @private
     */
    _startCharacteristicsNotifications(characteristicId) {
        return new Promise((resolve, reject) => {
            const ack = false;
            this._adapter.startCharacteristicsNotifications(characteristicId, ack, error => {
                if (error) {
                    reject(createError(ErrorCode.NOTIFICATION_START_ERROR, error.message));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Handle connection parameter update requests from the target device.
     *
     * @param device the device that requested connection parameter update
     * @param connectionParameters connection parameters from device
     * @private
     */
    _handleConnParamUpdateRequest(device, connectionParameters) {
        const connectedDevice = this._getConnectedDevice(this._transportParameters.targetAddress);
        if (connectedDevice && connectedDevice.instanceId === device.instanceId) {
            this._debug('Received connection parameter update request from target device.');
            this._adapter.updateConnectionParameters(device.instanceId, connectionParameters, err => {
                if (err) {
                    throw createError(ErrorCode.CONNECTION_PARAM_ERROR, err.message);
                }
            });
        }
    }

    /**
     * Write an array of objects with the given type, starting at the given
     * offset and crc32.
     *
     * @param objects array of objects (array of byte arrays)
     * @param type the ObjectType to write
     * @param offset the offset to start from
     * @param crc32 the crc32 to start from
     * @return Promise that resolves when the objects have been created and written
     * @private
     */
    _createAndWriteObjects(objects, type, offset, crc32) {
        return objects.reduce((prevPromise, object) => {
            return prevPromise.then(progress =>
                this._createAndWriteObject(object, type, progress.offset, progress.crc32)
            );
        }, Promise.resolve({ offset, crc32 }));
    }

    /**
     * Create and write one object with the given type, starting at the
     * given offset and crc32. If something fails, the operation will be retried
     * up to MAX_RETRIES times before returning error.
     *
     * @param data the object data to write (byte array)
     * @param type the ObjectType to write
     * @param offset the offset to start from
     * @param crc32 the crc32 to start from
     * @return Promise that resolves with updated progress ({ offset, crc32 })
     *         after the object has been written
     * @private
     */
    _createAndWriteObject(data, type, offset, crc32) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const tryWrite = () => {
                this._controlPointService.createObject(type, data.length)
                    .then(() => this._writeObject(data, type, offset, crc32))
                    .then(progress => resolve(progress))
                    .catch(error => {
                        attempts++;
                        if (this._shouldRetry(attempts, error)) {
                            tryWrite();
                        } else {
                            reject(error);
                        }
                    });
            };
            tryWrite();
        });
    }

    /**
     * Write one object with the given type, starting at the given offset
     * and crc32. Sends execute when the object has been written, and
     * returns updated progress (offset, crc32).
     *
     * @param data the object data to write (byte array)
     * @param type the ObjectType to write
     * @param offset the offset to start from
     * @param crc32 the crc32 to start from
     * @return Promise that resolves with updated progress ({ offset, crc32 })
     *         after the object has been written
     * @private
     */
    _writeObject(data, type, offset, crc32) {
        return this._objectWriter.writeObject(data, type, offset, crc32)
            .then(progress => {
                return this._validateProgress(progress)
                    .then(() => this._controlPointService.execute())
                    .then(() => progress);
            });
    }

    /**
     * Resume writing object data, starting at the given offset and crc32.
     * If an empty data array is given, then the writing will be skipped, and
     * it will jump straight to execute. We do not know if execute has already
     * been done or not. If execute has been done and we try to execute again,
     * the target device will respond with 'operation not permitted', so we
     * need to catch and ignore that error.
     *
     * @param data the remaining object data to write (byte array)
     * @param type the ObjectType to write
     * @param offset the offset to start from
     * @param crc32 the crc32 to start from
     * @return Promise that resolves with updated progress ({ offset, crc32 })
     *         after the object has been written
     * @private
     */
    _resumeWriteObject(data, type, offset, crc32) {
        if (data.length === 0) {
            const progress = {offset, crc32};
            return this._controlPointService.execute()
                .catch(error => {
                    if (error.code === ErrorCode.COMMAND_ERROR &&
                        error.commandErrorCode === ResultCode.OPERATION_NOT_PERMITTED) {
                        this._debug('Received OPERATION_NOT_PERMITTED when resuming and trying to execute. ' +
                            'This indicates that execute has already been done, so ignoring this.');
                    } else {
                        throw error;
                    }
                })
                .then(() => progress);
        } else {
            return this._writeObject(data, type, offset, crc32);
        }
    }

    _shouldRetry(attempts, error) {
        if (attempts < MAX_RETRIES &&
            error.code !== ErrorCode.ABORTED &&
            error.code !== ErrorCode.NOTIFICATION_TIMEOUT) {
            return true;
        }
        return false;
    }

    _validateProgress(progressInfo) {
        return this._controlPointService.calculateChecksum()
            .then(response => {
                // Same checks are being done in objectWriter. Could we reuse?
                if (progressInfo.offset !== response.offset) {
                    throw createError(ErrorCode.INVALID_OFFSET, `Error when validating offset. ` +
                        `Got ${response.offset}, but expected ${progressInfo.offset}.`);
                }
                if (progressInfo.crc32 !== response.crc32) {
                    throw createError(ErrorCode.INVALID_CRC, `Error when validating CRC. ` +
                        `Got ${response.crc32}, but expected ${progressInfo.crc32}.`);
                }
            });
    }

    _emitTransferEvent(offset, type) {
        const event = {
            stage: `Transferring ${this._getObjectTypeString(type)}`
        };
        if (type === ObjectType.DATA) {
            event.offset = offset;
        }
        this.emit('progressUpdate', event);
    }

    _emitInitializeEvent(type) {
        this.emit('progressUpdate', {
            stage: `Initializing ${this._getObjectTypeString(type)}`
        });
    }

    _getObjectTypeString(type) {
        switch (type) {
            case ObjectType.COMMAND:
                return 'init packet';
            case ObjectType.DATA:
                return 'firmware';
        }
        return 'unknown object';
    }

    _debug(message) {
        this.emit('logMessage', logLevel.DEBUG, message);
    }
}

module.exports = DfuTransport;
