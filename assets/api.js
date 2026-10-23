import { PublicError, codeMatches, historyPoints, liveSnapshot, stateMatches, validateParams } from "./model.js";

export const API_ORIGIN = "https://iot-api.heclouds.com";

export class RequestScope {
  constructor(timeoutMs, message = "等待超时，请刷新核对设备状态") {
    this.deadline = Date.now() + timeoutMs;
    this.reason = null;
    this.listeners = new Set();
    this.timer = setTimeout(() => this.cancel(message), timeoutMs);
  }
  assertActive() {
    if (!this.reason && Date.now() >= this.deadline) this.cancel("等待超时，请刷新核对设备状态");
    if (this.reason) throw this.reason;
  }
  onCancel(fn) {
    if (this.reason) fn(this.reason); else this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  cancel(message) {
    if (this.reason) return;
    this.reason = new PublicError(message);
    clearTimeout(this.timer);
    for (const fn of this.listeners) { try { fn(this.reason); } catch {} }
    this.listeners.clear();
  }
  close() { clearTimeout(this.timer); this.listeners.clear(); }
  guard(operation) {
    return new Promise((resolve, reject) => {
      let done = false, unsubscribe = () => {};
      const fail = error => { if (!done) { done = true; unsubscribe(); reject(error); } };
      unsubscribe = this.onCancel(fail);
      if (done) return;
      Promise.resolve().then(() => { this.assertActive(); return operation(); }).then(value => {
        if (done) return;
        try { this.assertActive(); done = true; unsubscribe(); resolve(value); } catch (error) { fail(error); }
      }, fail);
    });
  }
  wait(ms) {
    return this.guard(() => new Promise(resolve => {
      const id = setTimeout(() => { unsubscribe(); resolve(); }, ms);
      const unsubscribe = this.onCancel(() => clearTimeout(id));
    }));
  }
}

export class OneNetClient {
  constructor(config, { fetchFn = globalThis.fetch, now = Date.now } = {}) {
    if (!config || [config.product, config.device, config.token].some(value => typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))) throw new PublicError("请填写产品ID、设备名称和设备级HTTP Token");
    this.product = config.product.trim();
    this.device = config.device.trim();
    this.token = config.token.trim();
    // Native fetch requires its global receiver in Edge/Chromium.
    this.fetch = fetchFn.bind(globalThis);
    this.now = now;
    this.busy = false;
    this.lastCommandAt = -Infinity;
  }
  identity() { return encodeURIComponent(JSON.stringify([this.product, this.device])); }
  query() { return { product_id: this.product, device_name: this.device }; }
  async request(path, { params, body, scope, timeoutMs = body ? 12000 : 6500 } = {}) {
    scope?.assertActive();
    const local = new RequestScope(timeoutMs, body ? "控制请求等待超时；设备可能已执行，请先核对" : "读取超时，请检查网络后刷新");
    const unlink = scope ? scope.onCancel(error => local.cancel(error.message)) : () => {};
    const controller = new AbortController();
    const unabort = local.onCancel(() => controller.abort());
    try {
      return await local.guard(async () => {
        const url = new URL(path, API_ORIGIN);
        if (url.origin !== API_ORIGIN) throw new PublicError("接口地址无效");
        for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
        const response = await this.fetch(url.toString(), {
          method: body ? "POST" : "GET", mode: "cors", credentials: "omit", cache: "no-store",
          redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
          headers: { authorization: this.token, ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        local.assertActive(); scope?.assertActive();
        if (!response.ok) throw new PublicError(response.status === 401 || response.status === 403 ? "授权未通过，请检查设备级Token和有效期" : "OneNET暂不可访问，请稍后刷新");
        const reply = await response.json();
        local.assertActive(); scope?.assertActive();
        if (!reply || typeof reply !== "object" || !codeMatches(reply.code, 0) || !("data" in reply)) throw new PublicError("OneNET请求未通过，请检查授权、设备与物模型");
        return reply.data;
      });
    } catch (error) {
      if (error instanceof PublicError) throw error;
      // Never expose raw fetch failures, response bodies or request headers.
      throw new PublicError(body ? "控制结果未确认；请刷新核对，不要立即重复操作" : "无法读取OneNET：请检查网络、授权及浏览器跨域访问限制");
    } finally { unlink(); unabort(); local.close(); }
  }
  async readProperties(scope) {
    const properties = await this.request("/thingmodel/query-device-property", { params: this.query(), scope });
    if (!Array.isArray(properties)) throw new PublicError("设备数据格式异常");
    return properties;
  }
  async readData(scope) {
    const own = !scope, parent = scope || new RequestScope(8500);
    try {
      const [properties, device] = await Promise.all([
        this.readProperties(parent), this.request("/device/detail", { params: this.query(), scope: parent }),
      ]);
      parent.assertActive();
      if (!device || ![0, 1, 2, "0", "1", "2"].includes(device.status)) throw new PublicError("网关状态格式异常");
      return { properties, gateway_status: Number(device.status), server_time: this.now() };
    } finally { if (own) parent.close(); }
  }
  async readHistory(scope) {
    const own = !scope, parent = scope || new RequestScope(8500), end = this.now(), start = end - 3600000;
    try {
      const series = await Promise.all(["CurrentTemperature", "CurrentHumidity"].map(async identifier => {
        const data = await this.request("/thingmodel/query-device-property-history", {
          params: { ...this.query(), identifier, start_time: start, end_time: end, sort: 2, limit: 120 }, scope: parent,
        });
        return historyPoints(data, identifier, start, end);
      }));
      parent.assertActive();
      return { temperature: series[0], humidity: series[1] };
    } finally { if (own) parent.close(); }
  }
  async control(input, { scope, onSending = () => {}, onUpdate = () => {} } = {}) {
    const params = validateParams(input);
    if (this.busy || this.now() - this.lastCommandAt < 3000) throw new PublicError("请等待上一条操作完成，稍后再试");
    const parent = scope || new RequestScope(25000, "本次控制等待已超时；请核对实际状态，勿重复下发");
    this.busy = true;
    try {
      const baseline = await this.readData(parent), before = liveSnapshot(baseline, this.now());
      parent.assertActive();
      if (!before.ready) throw new PublicError("网关离线、51状态过期或通信未就绪，未发送命令");
      if ("MotorTarget" in params && !before.motor_control_ready) throw new PublicError("电机实际档位与PWM尚未就绪，未发送命令");
      if ("HumidityLow" in params && !before.humidity_ready) throw new PublicError("湿度阈值尚未就绪，未发送命令");
      if ("AlarmMuted" in params && before.alarm !== true) throw new PublicError("当前没有有效报警，无需修改消音状态");
      const sentAt = this.now();
      // Persist a non-secret review marker before the one and only write.
      onSending({ at: sentAt, motor: "MotorTarget" in params });
      parent.assertActive();
      this.lastCommandAt = sentAt;
      const reply = await this.request("/thingmodel/set-device-property", {
        body: { ...this.query(), params }, scope: parent,
      });
      if (!reply || !codeMatches(reply.code, 200)) throw new PublicError("设备未确认执行；请先刷新核对实际状态");
      const deadline = this.now() + 8000;
      while (true) {
        const properties = await this.readProperties(parent);
        parent.assertActive();
        onUpdate({ properties, gateway_status: 1, server_time: this.now() });
        if (stateMatches(properties, params, sentAt, this.now(), baseline.properties)) return { confirmed: true, properties, gateway_status: 1 };
        if (this.now() >= deadline) break;
        await parent.wait(700);
      }
      throw new PublicError("设备已回复，但新状态未核对成功；请刷新核对，不要立即重发");
    } finally { this.busy = false; if (!scope) parent.close(); }
  }
  forget() { this.token = ""; }
}
