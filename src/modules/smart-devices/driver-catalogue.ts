/**
 * The meter driver catalogue of getproperty-edge (D-013: a new meter model is a driver, never an API change). The
 * edge agent is the source of truth (`src/drivers/modbus/maps/*.json`, `src/drivers/pulse`); this list mirrors the
 * drivers released with edge E1.2/E1.3 so the staff binding wizard can offer them (web contract request
 * `GET /v1/staff/meter-drivers`, D-203). A device taken from a building's inventory keeps its own `device.driver`.
 * Adding a driver here is additive; keys are the edge's snake_case driver keys used in `MeterConfig.driver`.
 */
export interface MeterDriverDef {
  key: string;
  busType: 'modbus_rtu' | 'gpio' | 'lorawan' | 'nb_iot' | 'vendor_cloud';
  vendor: string;
  /** Model names the driver reads (register-compatible meters included). */
  models: string[];
  utility: 'electric' | 'water';
  /** Source of the register map / protocol, as in the edge driver map. */
  source: string;
}

export const METER_DRIVERS: readonly MeterDriverDef[] = [
  {
    key: 'eastron_sdm120',
    busType: 'modbus_rtu',
    vendor: 'Eastron',
    models: ['SDM120-Modbus'],
    utility: 'electric',
    source: 'Eastron SDM120-Modbus protocol V2.1 — input registers, float32, total kWh at 0x0048',
  },
  {
    key: 'eastron_sdm230',
    busType: 'modbus_rtu',
    vendor: 'Eastron',
    models: ['SDM230-Modbus'],
    utility: 'electric',
    source: 'Eastron SDM230-Modbus protocol V1.4 — input registers, float32, total kWh at 0x0048',
  },
  {
    key: 'pulse_counter',
    busType: 'gpio',
    vendor: 'Generic',
    models: ['Pulse-output water meter (reed / open collector)'],
    utility: 'water',
    source: 'GPIO pulse counting on the gateway; litres per pulse from the meter channel',
  },
];

export const driverOf = (key: string): MeterDriverDef | undefined => METER_DRIVERS.find((d) => d.key === key);
