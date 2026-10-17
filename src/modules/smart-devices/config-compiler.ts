import { createHash } from 'node:crypto';

import { sortKeys } from '@modules/ingest/protocol/device-protocol-schema';
import Decimal from 'decimal.js';

/** One open meter channel of a gateway, with what the compiler needs from its meter and position. */
export interface ChannelInput {
  meterDeviceId: string;
  /** `core.unit.unit_no` for unit meters, the assignment `code` for common-area / main meters (protocol mapping). */
  roomCode: string;
  utility: 'electric' | 'water';
  driver: string;
  busId: string;
  busType: 'modbus_rtu' | 'gpio' | 'lorawan' | 'nb_iot' | 'vendor_cloud';
  address: number | null;
  pin: number | null;
  registerMap: 'driver_default' | 'custom';
  customRegisterMap: Record<string, unknown> | null;
  scale: string;
  litresPerPulse: string | null;
  /** Pulse meters: the staff-confirmed register at install (D-033). */
  initialRegister: string | null;
}

export interface BusInput {
  id: string;
  type: 'modbus_rtu' | 'gpio' | 'lorawan';
  device?: string;
  baud?: number;
  parity?: 'none' | 'even' | 'odd';
}

export interface CompiledConfig {
  version: number;
  pollIntervalS: number;
  heartbeatS: number;
  buses: BusInput[];
  meters: Record<string, unknown>[];
}

/** Buses the gateway reads itself (cloud-to-cloud meters — NB-IoT, vendor clouds — never appear in a config). */
const GATEWAY_BUSES = new Set(['modbus_rtu', 'gpio', 'lorawan']);

/** Protocol defaults of a bus referenced by a channel but not configured on the gateway (`smart.device.bus_config`). */
export function defaultBus(id: string, type: 'modbus_rtu' | 'gpio' | 'lorawan'): BusInput {
  if (type === 'modbus_rtu') {
    const n = /^rs485-(\d+)$/.exec(id);
    return {
      id,
      type,
      device: `/dev/ttyUSB${n ? Math.max(0, Number(n[1]) - 1) : 0}`,
      baud: 9600,
      parity: 'none',
    };
  }
  return { id, type };
}

const decimalString = (v: string): string => new Decimal(v).toString();

/**
 * The GatewayConfig document of one gateway (D-131, device protocol §3): every open channel of the gateway as a
 * MeterConfig (`meterId` = the meter device, `roomCode` = unit number or assignment code), the buses they use
 * (configured settings first, protocol defaults otherwise), the polling and heartbeat intervals. Deterministic: the
 * same channels give the same document (meters sorted by room code then meter id, keys sorted), so an unchanged
 * gateway is never re-published.
 */
export function compileGatewayConfig(input: {
  version: number;
  pollIntervalS: number;
  heartbeatS: number;
  configuredBuses: BusInput[];
  channels: ChannelInput[];
}): CompiledConfig {
  const channels = input.channels
    .filter((c) => GATEWAY_BUSES.has(c.busType))
    .sort((a, b) => a.roomCode.localeCompare(b.roomCode) || a.meterDeviceId.localeCompare(b.meterDeviceId));
  const buses = new Map<string, BusInput>();
  for (const c of channels) {
    if (buses.has(c.busId)) continue;
    const configured = input.configuredBuses.find((b) => b.id === c.busId);
    buses.set(c.busId, configured ?? defaultBus(c.busId, c.busType as BusInput['type']));
  }
  const meters = channels.map((c) => {
    const unit = c.utility === 'electric' ? 'kwh' : 'm3';
    const meter: Record<string, unknown> = {
      meterId: c.meterDeviceId,
      roomCode: c.roomCode.slice(0, 32),
      driver: c.driver,
      bus: c.busId,
      unit,
      registerMap: c.registerMap,
      scale: decimalString(c.scale),
    };
    if (c.address !== null) meter.address = c.address;
    if (c.pin !== null) meter.pin = c.pin;
    if (c.registerMap === 'custom' && c.customRegisterMap) meter.customRegisterMap = c.customRegisterMap;
    if (c.litresPerPulse !== null) meter.litresPerPulse = new Decimal(c.litresPerPulse).toNumber();
    if (c.busType === 'gpio' && c.initialRegister !== null)
      meter.initialRegister = new Decimal(c.initialRegister).toFixed(3);
    return sortKeys(meter);
  });
  return sortKeys({
    version: input.version,
    pollIntervalS: input.pollIntervalS,
    heartbeatS: input.heartbeatS,
    buses: [...buses.values()].sort((a, b) => a.id.localeCompare(b.id)).map((b) => sortKeys(b)),
    meters,
  });
}

/** SHA-256 of the document without its version: equal hashes = nothing changed for the gateway. */
export function configContentHash(doc: CompiledConfig): Buffer {
  const { version: _version, ...content } = doc;
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(content)))
    .digest();
}
