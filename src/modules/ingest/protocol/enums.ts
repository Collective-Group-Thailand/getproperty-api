/**
 * Closed sets of the device protocol (docs/contract/device-protocol.md §3, D-130). Each becomes a
 * named definition in `contract/device-protocol.json`; `getproperty-edge` imports them by name.
 */

export enum MeterUnit {
  Kwh = 'kwh',
  M3 = 'm3',
}

export enum ReadingQuality {
  Good = 'good',
  EstimatedByGateway = 'estimated_by_gateway',
  ClockSuspect = 'clock_suspect',
  OverflowCorrected = 'overflow_corrected',
}

export enum LinkType {
  Ethernet = 'ethernet',
  Wifi = 'wifi',
  Lte = 'lte',
}

export enum MeterHealthStatus {
  Ok = 'ok',
  Timeout = 'timeout',
  CrcError = 'crc_error',
  NotFound = 'not_found',
}

export enum DeviceEventType {
  MeterOffline = 'meter_offline',
  PulseOverflow = 'pulse_overflow',
  ConfigApplied = 'config_applied',
  ConfigRejected = 'config_rejected',
  OtaStarted = 'ota_started',
  OtaApplied = 'ota_applied',
  OtaRolledBack = 'ota_rolled_back',
  OtaFailed = 'ota_failed',
  Tamper = 'tamper',
  PowerLoss = 'power_loss',
  Restart = 'restart',
  SeqGap = 'seq_gap',
}

export enum DeviceEventSeverity {
  Info = 'info',
  Warning = 'warning',
  Critical = 'critical',
}

export enum BusType {
  ModbusRtu = 'modbus_rtu',
  Gpio = 'gpio',
  Lorawan = 'lorawan',
}

export enum BusParity {
  None = 'none',
  Even = 'even',
  Odd = 'odd',
}

export enum RegisterMap {
  DriverDefault = 'driver_default',
  Custom = 'custom',
}

export enum CommandType {
  ReadNow = 'read_now',
  Restart = 'restart',
  OtaApply = 'ota_apply',
  UploadLogs = 'upload_logs',
  SetLogLevel = 'set_log_level',
  Identify = 'identify',
}

export enum CommandAckStatus {
  Accepted = 'accepted',
  Done = 'done',
  Failed = 'failed',
}
