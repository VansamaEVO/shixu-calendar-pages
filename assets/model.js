// Same data/confirmation contract as the retained Streamlit edition; no I/O.
export const FRESH_MS = 20000;
export const FUTURE_MS = 5000;
export const MOTOR_PWM = Object.freeze([0, 40, 50, 60]);
export const MOTOR_NAMES = Object.freeze(["停止", "低档", "中档", "高档"]);
export const FIELDS = new Set([
  "CurrentTemperature", "CurrentHumidity", "DeviceTime", "TemperatureLow", "TemperatureHigh",
  "HumidityLow", "HumidityHigh", "AlarmActive", "AlarmMuted", "McuOnline", "ControlReady",
  "TemperatureValid", "HumidityValid", "TemperatureAlarm", "HumidityAlarm", "AlcoholRaw",
  "AlcoholVoltage", "AlcoholIndex", "AlcoholValid", "MotorLevel", "MotorPWM", "MotorValid", "MotorTarget",
]);

export class PublicError extends Error {}

export function stamp(value) {
  if (typeof value === "boolean" || value == null || value === "" || !["string", "number"].includes(typeof value)) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n < 1e12 ? n * 1000 : n) : 0;
}

export function flag(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

export function integer(value, min, max) {
  if (typeof value === "boolean" || value == null || value === "" || !["string", "number"].includes(typeof value)) return null;
  if (typeof value === "string" && !/^-?[0-9]+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export function decimal(value, min, max) {
  if (typeof value === "boolean" || !["string", "number"].includes(typeof value)) return null;
  if (typeof value === "string" && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function parseDeviceTime(value) {
  if (typeof value !== "string" || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(value)) return null;
  // Explicit UTC+8, independent of the visitor's time zone; reject rolled dates.
  const parts = value.match(/\d+/g).map(Number);
  const at = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] - 8, parts[4], parts[5]);
  const d = new Date(at + 8 * 3600000);
  if ([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].some((n, i) => n !== parts[i])) return null;
  return { value, at, year: parts[0], month: parts[1], day: parts[2], weekday: d.getUTCDay() };
}

export function propertyMap(properties) {
  const out = new Map();
  if (Array.isArray(properties)) for (const item of properties) {
    if (item && typeof item === "object" && FIELDS.has(item.identifier)) out.set(item.identifier, item);
  }
  return out;
}

export function snapshot(properties, now = Date.now()) {
  const entries = propertyMap(properties);
  const fresh = key => {
    const item = entries.get(key), at = stamp(item?.time);
    return at > 0 && now - at >= -FUTURE_MS && now - at < FRESH_MS ? item : null;
  };
  const readFlag = key => flag(fresh(key)?.value);
  const number = (key, min, max) => {
    const value = fresh(key)?.value;
    if (["AlcoholRaw", "MotorLevel", "MotorPWM"].includes(key) && typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    return (key === "CurrentTemperature" ? decimal : integer)(value, min, max);
  };
  const coherent = (...keys) => keys.every(key => fresh(key)) && Math.max(...keys.map(key => stamp(entries.get(key)?.time))) - Math.min(...keys.map(key => stamp(entries.get(key)?.time))) <= 1000;
  const online = readFlag("McuOnline") === true;
  const lastTime = parseDeviceTime(entries.get("DeviceTime")?.value);
  const time = online && fresh("DeviceTime") ? lastTime : null;
  const low = number("TemperatureLow", 0, 99), high = number("TemperatureHigh", 0, 99);
  const hLow = number("HumidityLow", 0, 100), hHigh = number("HumidityHigh", 0, 100);
  const limitsValid = low !== null && high !== null && low < high;
  const hLimitsValid = hLow !== null && hHigh !== null && hLow < hHigh;
  const alarm = online ? readFlag("AlarmActive") : null, muted = online ? readFlag("AlarmMuted") : null;
  let tAlarm = online ? readFlag("TemperatureAlarm") : null, hAlarm = online ? readFlag("HumidityAlarm") : null;
  if (alarm === null || tAlarm === null || hAlarm === null || alarm !== (tAlarm || hAlarm) || !coherent("AlarmActive", "TemperatureAlarm", "HumidityAlarm")) tAlarm = hAlarm = null;
  const ready = online && readFlag("ControlReady") === true && !!time && limitsValid && alarm !== null && muted !== null;
  const raw = number("AlcoholRaw", 0, 4095);
  const aValid = online && readFlag("AlcoholValid") === true && raw !== null && coherent("AlcoholValid", "AlcoholRaw");
  const level = number("MotorLevel", 0, 3), pwm = number("MotorPWM", 0, 60);
  const mValid = online && readFlag("MotorValid") === true && level !== null && pwm === MOTOR_PWM[level] && coherent("MotorValid", "MotorLevel", "MotorPWM");
  return {
    online, ready, time, last_time: lastTime,
    temperature: online && readFlag("TemperatureValid") === true ? number("CurrentTemperature", -40, 125) : null,
    humidity: online && readFlag("HumidityValid") === true ? number("CurrentHumidity", 0, 100) : null,
    low: online && limitsValid ? low : null, high: online && limitsValid ? high : null,
    humidity_low: online && hLimitsValid ? hLow : null, humidity_high: online && hLimitsValid ? hHigh : null,
    humidity_ready: ready && hLimitsValid, alarm, muted, temperature_alarm: tAlarm, humidity_alarm: hAlarm,
    alcohol_valid: aValid, alcohol_raw: aValid ? raw : null,
    alcohol_voltage: aValid ? (((raw >> 3) * 125) >> 7) / 100 : null,
    alcohol_index: aValid ? Math.floor((raw * 100 + 2047) / 4095) : null,
    alcohol_at: stamp(entries.get("AlcoholRaw")?.time), motor_valid: mValid,
    motor_level: mValid ? level : null, motor_pwm: mValid ? pwm : null,
    motor_at: stamp(entries.get("MotorLevel")?.time), motor_control_ready: ready && mValid && entries.has("MotorTarget"),
    time_at: stamp(entries.get("DeviceTime")?.time),
    updated_at: Math.max(0, ...Array.from(entries.values(), item => stamp(item.time))),
  };
}

export function liveSnapshot(data, now = Date.now()) {
  const state = snapshot(data?.properties, now);
  if (data?.gateway_status !== 1) {
    Object.assign(state, { online: false, ready: false, humidity_ready: false, time: null,
      temperature: null, humidity: null, low: null, high: null, humidity_low: null, humidity_high: null,
      alarm: null, muted: null, temperature_alarm: null, humidity_alarm: null,
      alcohol_valid: false, alcohol_raw: null, alcohol_voltage: null, alcohol_index: null,
      motor_valid: false, motor_level: null, motor_pwm: null, motor_control_ready: false });
  }
  return state;
}

export function validateParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new PublicError("控制参数无效");
  const keys = Object.keys(params).sort().join(",");
  if (keys === "TemperatureHigh,TemperatureLow" || keys === "HumidityHigh,HumidityLow") {
    const humidity = keys.startsWith("Humidity"), prefix = humidity ? "Humidity" : "Temperature", max = humidity ? 100 : 99;
    const low = params[prefix + "Low"], high = params[prefix + "High"];
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high > max || low >= high) throw new PublicError(`${humidity ? "湿度" : "温度"}范围须为0-${max}的整数，且下限小于上限`);
  } else if (keys === "DeviceTime") {
    if (!parseDeviceTime(params.DeviceTime)) throw new PublicError("日期时间无效，仅支持2000-2099年");
  } else if (keys === "AlarmMuted") {
    if (typeof params.AlarmMuted !== "boolean") throw new PublicError("消音参数无效");
  } else if (keys === "MotorTarget") {
    if (!Number.isInteger(params.MotorTarget) || params.MotorTarget < 0 || params.MotorTarget > 3) throw new PublicError("电机仅接受0-3档，最高60% PWM");
  } else throw new PublicError("一次只能修改一组设置");
  return { ...params };
}

export const codeMatches = (value, expected) => (Number.isInteger(value) && value === expected) || (typeof value === "string" && value === String(expected));

export function stateMatches(properties, params, sentAt, now, baseline) {
  const state = snapshot(properties, now), current = propertyMap(properties), previous = propertyMap(baseline);
  if (!state.ready || ("HumidityLow" in params && !state.humidity_ready)) return false;
  const newer = key => {
    const item = current.get(key), old = previous.get(key), at = stamp(item?.time);
    return !!item && !!old && at >= sentAt - 1000 && at > stamp(old.time);
  };
  if ("MotorTarget" in params) return state.motor_control_ready && state.motor_level === params.MotorTarget && newer("MotorLevel");
  return Object.entries(params).every(([key, expected]) => {
    if (!newer(key)) return false;
    const value = current.get(key).value;
    if (key === "AlarmMuted") return flag(value) === expected;
    if (key === "DeviceTime") {
      const actual = parseDeviceTime(value), requested = parseDeviceTime(expected);
      return !!actual && !!requested && actual.at - requested.at >= -1000 && actual.at - requested.at <= now - sentAt + 5000;
    }
    return integer(value, 0, key.startsWith("Humidity") ? 100 : 99) === expected;
  });
}

export function historyPoints(data, identifier, start, end) {
  if (!data || !Array.isArray(data.list)) throw new PublicError("历史数据格式异常");
  const points = new Map(), temperature = identifier === "CurrentTemperature";
  for (const item of data.list) {
    const at = stamp(item?.time), value = (temperature ? decimal : integer)(item?.value, temperature ? -40 : 0, temperature ? 125 : 100);
    if (at >= start && at <= end + FUTURE_MS && value !== null) points.set(at, { at, value });
  }
  return Array.from(points.values()).sort((a, b) => a.at - b.at).slice(-120);
}
