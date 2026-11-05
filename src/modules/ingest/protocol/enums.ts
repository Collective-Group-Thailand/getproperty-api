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
  /** The register went down without a swap or rollover (CR-007): sent unchanged, reviewed in the cloud. */
  RegisterDecrease = 'register_decrease',
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
  /** 1.3 (D-328): a barrier reports its position; `data` = GateStateData. */
  GateState = 'gate.state',
  /** 1.3 (D-328): an LPR camera read a plate; `data` = PlateDetectedData. */
  PlateDetected = 'plate.detected',
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

/** Modbus function used to read a register of a custom map (CR-005). */
export enum ModbusFunction {
  Holding = 'holding',
  Input = 'input',
}

/** Data type of a Modbus register in a custom map (CR-005). */
export enum RegisterDataType {
  Uint16 = 'uint16',
  Int16 = 'int16',
  Uint32 = 'uint32',
  Int32 = 'int32',
  Float32 = 'float32',
  Uint64 = 'uint64',
  Float64 = 'float64',
}

/** Word order of multi-register values (CR-005). */
export enum WordOrder {
  BigEndian = 'big_endian',
  LittleEndian = 'little_endian',
}

export enum CommandType {
  ReadNow = 'read_now',
  Restart = 'restart',
  OtaApply = 'ota_apply',
  UploadLogs = 'upload_logs',
  SetLogLevel = 'set_log_level',
  Identify = 'identify',
  /** 1.3 (D-328): pulse a barrier relay; `args` = GateOpenArgs. */
  GateOpen = 'gate.open',
}

export enum CommandAckStatus {
  Accepted = 'accepted',
  Done = 'done',
  Failed = 'failed',
}

/** 1.3 (D-328): position of a barrier reported in `gate.state`. */
export enum GateBarrierState {
  Open = 'open',
  Closed = 'closed',
  Fault = 'fault',
}

/** 1.3 (D-328): gate hardware an edge gateway drives (`GatewayConfig.gateDevices[].kind`). */
export enum GateHardwareKind {
  Barrier = 'barrier',
  Lpr = 'lpr',
}

/** 1.3 (D-328): why the cloud asked a barrier to open (`GateOpenArgs.reason`). */
export enum GateOpenReason {
  Visit = 'visit',
  Resident = 'resident',
  Delivery = 'delivery',
  Service = 'service',
  Emergency = 'emergency',
  Other = 'other',
  LprKnownPlate = 'lpr_known_plate',
  ResidentApp = 'resident_app',
}
