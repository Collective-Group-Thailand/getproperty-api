/**
 * Wire formats shared by the MQTT DTOs (device-protocol.md §3; contract §3 "Meter quantities").
 * Register values are `numeric(12,3)`: up to 9 integer digits and 3 decimals, never a JSON number.
 */
export const REGISTER_PATTERN = /^\d{1,9}(\.\d{1,3})?$/;
export const REGISTER_PATTERN_SOURCE = '^\\d{1,9}(\\.\\d{1,3})?$';

/** Decimal scale factor applied by the gateway driver (`"1"`, `"0.1"`, `"10"`). */
export const SCALE_PATTERN = /^\d{1,6}(\.\d{1,6})?$/;
export const SCALE_PATTERN_SOURCE = '^\\d{1,6}(\\.\\d{1,6})?$';

/** Driver names are an open set owned by `getproperty-edge` (D-013): `snake_case` identifiers. */
export const DRIVER_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
export const DRIVER_PATTERN_SOURCE = '^[a-z][a-z0-9_]{1,63}$';

/** Bus ids like `rs485-1`, `gpio`, `lora-0`. */
export const BUS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const BUS_ID_PATTERN_SOURCE = '^[a-z0-9][a-z0-9-]{0,31}$';

/** Semantic version of the agent, e.g. `1.4.2` (pre-release suffix allowed). */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const SEMVER_PATTERN_SOURCE = '^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$';

/** The payload size limit of one telemetry batch (device-protocol.md §4). */
export const MAX_READINGS_PER_BATCH = 200;
