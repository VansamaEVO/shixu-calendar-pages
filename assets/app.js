import { OneNetClient, RequestScope } from "./api.js";
import { PublicError, MOTOR_NAMES, liveSnapshot, propertyMap, stamp, validateParams } from "./model.js";
import { drawMotorDial } from "./instrument.js";

const $ = id => document.getElementById(id);
const put = (id, value) => { $(id).textContent = value; };
const show = (id, value) => { $(id).hidden = !value; };
const chinaFormat = (at, options) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, ...options }).format(new Date(at));
const atLabel = at => at ? chinaFormat(at, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
const message = (id, text, tone = "") => { const node = $(id); node.textContent = text; node.className = `notice ${tone}`; node.hidden = !text; };
let client = null, currentData = { properties: [], gateway_status: 0 }, generation = 0;
let pollPromise = null, pollScope = null, historyScope = null, activeControl = null, busy = false;
let review = null, reviewCheckedAt = 0, reviewKey = "", networkError = "", historyBusy = false;
let alcohol = [], alcoholGap = false, environment = { temperature: [], humidity: [] }, historyMode = false;
const dirty = new Set(), log = [];
const draftKeys = ["draft-date", "draft-time", "draft-low", "draft-high", "draft-h-low", "draft-h-high"];
const SAVED_CONFIG_KEY = "shixu.pages.device.v1";
let autoFilledToken = "", credentialWarning = "";

function readSavedConfig() {
  try {
    const raw = localStorage.getItem(SAVED_CONFIG_KEY);
    if (!raw || raw.length > 65536) return null;
    const saved = JSON.parse(raw);
    if (!saved || [saved.product, saved.device].some(value => typeof value !== "string" || !value.trim() || value.length > 128 || /[\r\n]/.test(value))) return null;
    const token = typeof saved.token === "string" && saved.token.trim() && saved.token.length <= 16384 && !/[\r\n]/.test(saved.token) ? saved.token.trim() : "";
    return { product:saved.product.trim(), device:saved.device.trim(), token };
  } catch {}
  return null;
}

function savedIdentityMatches(saved) {
  return saved && saved.product === $("config-product").value.trim() && saved.device === $("config-device").value.trim();
}

function updateSavedTokenStatus() {
  const saved = readSavedConfig();
  put("config-saved-status", saved?.token ? savedIdentityMatches(saved) ? "已记住此设备Token，下次自动填入" : "已记住上次设备Token；连接新设备后替换" : "输入并连接后，自动记住Token");
  $("config-clear-token").disabled = busy;
}

function fillSavedToken() {
  // Changing identity must never carry an automatically filled token to another device.
  if (autoFilledToken && $("config-token").value === autoFilledToken) $("config-token").value = "";
  autoFilledToken = "";
  const saved = readSavedConfig();
  if (saved?.token && savedIdentityMatches(saved) && !$("config-token").value) {
    $("config-token").value = saved.token;
    autoFilledToken = saved.token;
  }
  updateSavedTokenStatus();
}

function loadSavedConfig() {
  const saved = readSavedConfig();
  if (saved) { $("config-product").value = saved.product; $("config-device").value = saved.device; }
  fillSavedToken();
}

function rememberConfig(config) {
  // User-requested local persistence only; never embed a token in files, URLs or logs.
  try {
    localStorage.setItem(SAVED_CONFIG_KEY, JSON.stringify({ product:config.product, device:config.device, token:config.token }));
    const saved = readSavedConfig();
    return saved?.product === config.product && saved?.device === config.device && saved?.token === config.token;
  } catch { return false; }
}

function forgetSavedToken() {
  const saved = readSavedConfig();
  if (saved) localStorage.setItem(SAVED_CONFIG_KEY, JSON.stringify({ product:saved.product, device:saved.device }));
  else localStorage.removeItem(SAVED_CONFIG_KEY);
  const raw = localStorage.getItem(SAVED_CONFIG_KEY);
  if (raw && Object.hasOwn(JSON.parse(raw), "token")) throw new Error("Token was not removed");
}

function readReview() {
  review = null;
  reviewCheckedAt = 0;
  try {
    const item = JSON.parse(sessionStorage.getItem(reviewKey) || "null");
    if (item && Number.isFinite(item.at) && item.at > 0) review = { at: item.at, motor: item.motor === true };
  } catch {}
}

function persistReview(item) {
  // No token, desired parameters or raw API replies are stored.
  try { sessionStorage.setItem(reviewKey, JSON.stringify({ at: item.at, motor: item.motor === true })); }
  catch { throw new PublicError("浏览器无法保存待核对标记，未发送命令；请允许此站点的会话存储后再试"); }
  review = item;
  reviewCheckedAt = 0;
}

function clearReview() {
  try { sessionStorage.removeItem(reviewKey); }
  catch { throw new PublicError("待核对标记未能清除，请检查浏览器存储设置"); }
  review = null;
  reviewCheckedAt = 0;
}

function addLog(text, success) {
  log.unshift({ text, success, at: Date.now() });
  log.splice(10);
  const list = $("operation-log");
  list.replaceChildren(...log.map(item => {
    const row = document.createElement("li");
    row.textContent = `${atLabel(item.at)} · ${item.success ? "已确认" : "未确认"} · ${item.text}`;
    return row;
  }));
}

function calendar(time) {
  const container = $("month-days");
  if (!time) {
    put("month-label", "---- / --");
    container.replaceChildren(...Array.from({ length: 35 }, () => {
      const cell = document.createElement("span"); cell.textContent = "–"; return cell;
    }));
    container.setAttribute("aria-label", "等待设备日期");
    return;
  }
  put("month-label", `${time.year} / ${String(time.month).padStart(2, "0")}`);
  const first = new Date(Date.UTC(time.year, time.month - 1, 1)), offset = (first.getUTCDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(time.year, time.month - 1, i - offset + 1)), cell = document.createElement("span");
    cell.textContent = String(d.getUTCDate());
    if (d.getUTCMonth() !== time.month - 1) cell.className = "outside";
    else if (d.getUTCDate() === time.day) { cell.className = "today"; cell.setAttribute("aria-current", "date"); }
    cells.push(cell);
  }
  container.replaceChildren(...cells);
  container.setAttribute("aria-label", `${time.year}年${time.month}月，以设备日期为准`);
}

const svgNode = (tag, attrs = {}, text) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
};

function drawChart(target, series, { small = false, empty = "等待真实采样", leftDomain = [0, 40], rightDomain = [0, 100] } = {}) {
  const root = $(target), width = Math.max(320, Math.round(root.clientWidth || 600)), height = small ? 170 : 220;
  const left = small ? 28 : 34, right = small ? 12 : 35, top = 15, bottom = 27;
  const data = series.flatMap(item => item.points), times = data.map(point => point.at);
  let start = Math.min(...times), end = Math.max(...times);
  if (!data.length) { start = 0; end = 1; }
  if (start === end) { start -= 5000; end += 5000; }
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
  for (let i = 0; i < 5; i++) {
    const ratio = i / 4, y = top + ratio * (height - top - bottom);
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y, y2: y, stroke: "#e7ede2", "stroke-width": 1 }));
    const val = leftDomain[1] - ratio * (leftDomain[1] - leftDomain[0]);
    svg.append(svgNode("text", { x: left - 7, y: y + 4, fill: "#7c8d75", "font-size": 12, "text-anchor": "end" }, Number(val.toFixed(1)).toString()));
    if (!small) svg.append(svgNode("text", { x: width - right + 7, y: y + 4, fill: "#7c8d75", "font-size": 12 }, String(rightDomain[1] - ratio * (rightDomain[1] - rightDomain[0]))));
  }
  for (let i = 0; i < 3; i++) {
    const at = start + (end - start) * i / 2;
    svg.append(svgNode("text", { x: left + (width - left - right) * i / 2, y: height - 6, fill: "#9eaa95", "font-size": 11, "text-anchor": i === 0 ? "start" : i === 2 ? "end" : "middle" }, data.length ? chinaFormat(at, { hour: "2-digit", minute: "2-digit" }) : "--:--"));
  }
  for (const item of series) {
    const domain = item.right ? rightDomain : leftDomain;
    const x = p => left + (p.at - start) / (end - start) * (width - left - right);
    const y = p => top + (domain[1] - p.value) / (domain[1] - domain[0]) * (height - top - bottom);
    if (small && item.points.length > 1) {
      const gradientId = `${target}-area`;
      const gradient = svgNode("linearGradient", { id:gradientId, x1:"0%", y1:"0%", x2:"0%", y2:"100%" });
      gradient.append(svgNode("stop", { offset:"0%", "stop-color":item.color, "stop-opacity":.17 }), svgNode("stop", { offset:"100%", "stop-color":item.color, "stop-opacity":.015 }));
      const defs = svgNode("defs"); defs.append(gradient); svg.append(defs);
      let run = [], previous = null;
      const paint = () => {
        if (run.length > 1) {
          const line = run.map((point, i) => `${i ? "L" : "M"}${x(point).toFixed(2)},${y(point).toFixed(2)}`).join(" ");
          const base = height - bottom;
          svg.append(svgNode("path", { d:`${line} L${x(run[run.length - 1]).toFixed(2)},${base} L${x(run[0]).toFixed(2)},${base} Z`, fill:`url(#${gradientId})`, stroke:"none" }));
        }
        run = [];
      };
      for (const point of item.points) {
        if (previous && (point.breakBefore || point.at - previous.at > 20000)) paint();
        run.push(point); previous = point;
      }
      paint();
    }
    let path = "", previous = null;
    for (const point of item.points) {
      const contiguous = previous && !point.breakBefore && point.at - previous.at <= 20000;
      path += `${contiguous ? "L" : "M"}${x(point).toFixed(2)},${y(point).toFixed(2)} `;
      const latest = point === item.points[item.points.length - 1];
      const circle = svgNode("circle", { cx: x(point).toFixed(2), cy: y(point).toFixed(2), r: latest ? 4 : 1.5, fill: item.color, stroke: latest ? "#fffefb" : "none", "stroke-width": latest ? 2 : 0 });
      circle.append(svgNode("title", {}, `${atLabel(point.at)} · ${point.value}${item.unit}`));
      svg.append(circle);
      previous = point;
    }
    if (path) svg.append(svgNode("path", { d: path, fill: "none", stroke: item.color, "stroke-width": 2.1, "stroke-linejoin": "round" }));
  }
  root.replaceChildren(svg);
  root.setAttribute("aria-label", data.length ? `真实数据曲线，共${data.length}个有效采样点；较长缺报处断线` : empty);
  if (!data.length) { const label = document.createElement("span"); label.className = "empty-chart-label"; label.textContent = empty; root.append(label); }
}

function drawTrends() {
  drawChart("alcohol-chart", [{ points: alcohol, color: "#8aa775", unit: "V" }], { small: true, leftDomain: [0, 5], empty: "等待真实酒精采样" });
  put("alcohol-count", `${alcohol.length} 个有效点`);
  put("alcohol-peak", alcohol.length ? Math.round(Math.max(...alcohol.map(point => point.value)) * 20) : "--");
  const temperatures = environment.temperature.map(point => point.value);
  const low = Math.min(0, temperatures.length ? Math.floor((Math.min(...temperatures) - 2) / 10) * 10 : 0);
  const high = Math.max(40, temperatures.length ? Math.ceil((Math.max(...temperatures) + 2) / 10) * 10 : 40);
  drawChart("environment-chart", [
    { points: environment.temperature, color: "#bb784c", unit: "°C" },
    { points: environment.humidity, color: "#418e8b", unit: "%RH", right: true },
  ], { leftDomain: [low, high], empty: "连接后显示真实温湿度采样" });
}

function recordSamples(data) {
  const now = Date.now(), state = liveSnapshot(data, now), entries = propertyMap(data.properties);
  const prune = points => points.filter(point => point.at >= now - 3600000).slice(-120);
  if (state.alcohol_valid) {
    const last = alcohol[alcohol.length - 1];
    if (!last || state.alcohol_at > last.at) {
      alcohol.push({ at: state.alcohol_at, value: state.alcohol_voltage, breakBefore: alcoholGap });
      alcoholGap = false;
    }
  } else alcoholGap = true;
  alcohol = prune(alcohol);
  if (!historyMode) for (const [name, field] of [["temperature", "CurrentTemperature"], ["humidity", "CurrentHumidity"]]) {
    const value = state[name], at = stamp(entries.get(field)?.time), points = environment[name];
    if (value !== null && (!points.length || at > points[points.length - 1].at)) points.push({ at, value });
    environment[name] = prune(points);
  }
  drawTrends();
}

function loadDrafts(state, force = false) {
  const values = { "draft-date": state.time?.value.slice(0, 10), "draft-time": state.time?.value.slice(11),
    "draft-low": state.low, "draft-high": state.high, "draft-h-low": state.humidity_low, "draft-h-high": state.humidity_high };
  for (const [key, value] of Object.entries(values)) if (value != null && (force || !dirty.has(key))) $(key).value = String(value);
}

function render() {
  const state = liveSnapshot(currentData), connected = !!client;
  const allowed = connected && state.ready && !busy && !review;
  show("welcome", !connected);
  put("connection-label", !connected ? "尚未连接" : networkError ? "读取异常" : state.online ? "设备在线" : "设备离线 / 待上报");
  $("connection-dot").className = `dot ${state.online ? "online" : networkError ? "error" : ""}`;
  put("connection-note", !connected ? "连接设备后查看最新状态" : networkError ? "暂时无法读取云端，请检查网络后刷新" : currentData.gateway_status !== 1 ? "ESP尚未连接OneNET，等待设备上线" : state.online ? "ESP与51通信正常，设备数据定时更新" : "ESP已连接，等待51有效数据回传");
  put("summary-report", atLabel(state.updated_at));
  const time = state.time || state.last_time;
  put("device-clock", time ? time.value.slice(11) : "--:--:--");
  $("device-clock").classList.toggle("frozen", !state.time);
  put("device-date", time ? time.value.slice(0, 10).replaceAll("-", " / ") : "等待设备日期");
  put("device-weekday", time ? `星期${"日一二三四五六"[time.weekday]}` : "星期 --");
  put("clock-source", state.time ? "51设备时间" : time ? "历史记录" : "等待设备上报");
  // No local ticking or fabricated extrapolation of the device clock.
  $("clock-note").textContent = state.time ? "设备真实回传 · 每5秒核对" : time ? "最近记录 · 已停止更新" : "仅显示51实际回传的设备时间";
  calendar(time);
  put("temperature", state.temperature === null ? "--" : state.temperature.toFixed(1));
  put("humidity", state.humidity === null ? "--" : state.humidity);
  put("temperature-note", state.temperature === null ? "等待有效温度读数" : "DS18B20 · 有效采集");
  put("humidity-note", state.humidity === null ? "等待有效湿度读数" : "DHT11 · 有效采集");
  const tRange = state.low === null ? "等待阈值上报" : `${state.low}°C ~ ${state.high}°C`;
  const hRange = state.humidity_low === null ? "等待阈值上报" : `${state.humidity_low}% ~ ${state.humidity_high}%`;
  put("temperature-range", tRange); put("humidity-range", hRange);
  put("settings-temperature", state.low === null ? "-- °C 至 -- °C" : tRange);
  put("settings-humidity", state.humidity_low === null ? "--% 至 --%" : hRange);
  let alarmTitle = "等待状态上报", alarmBadge = "待上报", alarmNote = "无新鲜数据，不把旧报警作为当前状态。";
  if (state.alarm === false) { alarmTitle = "当前未触发报警"; alarmBadge = "无报警"; alarmNote = "由51判定，温湿度阈值独立设置。"; }
  if (state.alarm === true) {
    alarmTitle = state.temperature_alarm && state.humidity_alarm ? "温湿度同时越限" : state.temperature_alarm ? "温度越限" : state.humidity_alarm ? "湿度越限" : "设备越限 · 来源待上报";
    alarmBadge = state.muted === true ? "已消音" : "报警中";
    alarmNote = state.muted === true ? "临时消音约10秒，仍超限会再次报警。" : state.muted === false ? "蜂鸣器正在报警。" : "声音状态待更新。";
  }
  put("alarm-title", alarmTitle); put("alarm-badge", alarmBadge); put("alarm-note", alarmNote); put("sound-status", alarmNote);
  $("alarm-badge").className = `badge ${state.alarm === true ? "alarming" : ""}`;
  put("alcohol-badge", state.alcohol_valid ? "有效采样" : "待上报");
  put("alcohol-voltage", state.alcohol_valid ? state.alcohol_voltage.toFixed(2) : "--");
  put("alcohol-index", state.alcohol_valid ? state.alcohol_index : "--");
  put("alcohol-raw", state.alcohol_valid ? state.alcohol_raw : "--");
  $("alcohol-bar").style.width = `${state.alcohol_valid ? state.alcohol_index : 0}%`;
  put("motor-level", state.motor_valid ? MOTOR_NAMES[state.motor_level] : "--");
  put("motor-pwm", state.motor_valid ? state.motor_pwm : "--");
  put("motor-badge", state.motor_valid ? state.motor_level > 0 ? "运行中" : "已停止" : "待上报");
  $("motor-fan").classList.toggle("running", state.motor_valid && state.motor_level > 0);
  drawMotorDial($("motor-dial"), state);
  document.querySelectorAll("[data-motor]").forEach(button => {
    const selected = state.motor_valid && Number(button.dataset.motor) === state.motor_level;
    button.disabled = !allowed || !state.motor_control_ready;
    button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected));
  });
  put("motor-note", busy ? "正在等待设备确认，并核对实际档位。" : review ? "上次控制结果待核对，请先刷新查看实际状态。" : state.motor_control_ready ? "选择所需档位，收到新的实际回报后确认。PWM占空比不是实测转速。" : "等待设备上报有效的实际档位与PWM状态。");
  put("settings-status", allowed ? "可操作" : busy ? "核对中" : review ? "待核对" : "未就绪");
  document.querySelectorAll("[data-requires]").forEach(button => { button.disabled = !allowed || (button.dataset.requires === "humidity" && !state.humidity_ready); });
  draftKeys.forEach(key => { $(key).disabled = !allowed || (key.startsWith("draft-h-") && !state.humidity_ready); });
  $("mute").disabled = !allowed || state.alarm !== true || state.muted !== false;
  $("unmute").disabled = !allowed || state.alarm !== true || state.muted !== true;
  $("reload-drafts").disabled = !allowed;
  $("refresh").disabled = !connected || busy;
  $("load-history").disabled = !connected || historyBusy || busy;
  $("disconnect").disabled = !connected || busy;
  $("config-open").disabled = busy;
  $("review-refresh").disabled = !connected || busy;
  $("review-clear").disabled = !review || busy || !state.ready || (review.motor && !state.motor_control_ready) || reviewCheckedAt <= review.at;
  show("control-progress", busy); show("review-panel", !!review && !busy);
  put("gateway-status", !connected ? "尚未连接" : currentData.gateway_status === 1 ? "在线" : "离线或不可访问");
  put("mcu-status", state.online ? "在线，状态新鲜" : "离线或数据超过20秒");
  put("last-report", atLabel(state.updated_at));
  put("device-identity", connected ? `产品ID：${client.product}　设备：${client.device}` : "未配置设备");
  message("network-notice", networkError, "error");
  message("credential-notice", credentialWarning);
  updateSavedTokenStatus();
  loadDrafts(state);
}

async function refresh({ reviewRead = false } = {}) {
  if (!client || busy) return false;
  if (pollPromise) return pollPromise;
  const target = client, epoch = generation, scope = new RequestScope(8500, "读取等待已超时，请检查网络后刷新");
  pollScope = scope;
  const promise = (async () => {
    try {
      const result = await target.readData(scope);
      scope.assertActive();
      if (epoch !== generation || client !== target) return false;
      currentData = result; networkError = "";
      if (reviewRead) reviewCheckedAt = Date.now();
      recordSamples(result); render(); return true;
    } catch (error) {
      if (epoch !== generation || client !== target) return false;
      currentData = { ...currentData, gateway_status: 0 }; alcoholGap = true;
      networkError = error instanceof PublicError ? error.message : "读取失败，请稍后刷新";
      render(); return false;
    } finally {
      scope.close();
      if (pollScope === scope) pollScope = null;
      if (pollPromise === promise) pollPromise = null;
    }
  })();
  pollPromise = promise;
  return promise;
}

function cancelReads() {
  pollScope?.cancel("连接已变更，本次读取结束");
  historyScope?.cancel("连接已变更，本次历史读取结束");
  pollScope = historyScope = null; pollPromise = null; historyBusy = false;
}

function disconnect() {
  if (busy) return;
  generation++; cancelReads(); client?.forget(); client = null;
  currentData = { properties: [], gateway_status: 0 }; networkError = ""; review = null; reviewCheckedAt = 0; reviewKey = "";
  alcohol = []; alcoholGap = false; environment = { temperature: [], humidity: [] }; historyMode = false; dirty.clear();
  log.length = 0;
  const emptyLog = document.createElement("li"); emptyLog.textContent = "本次浏览尚无控制记录。";
  $("operation-log").replaceChildren(emptyLog);
  put("history-mode", "本次浏览收到的有效样本 · 不生成模拟数据");
  put("history-note", "历史曲线按需读取，不阻塞首次打开和实时监测。");
  draftKeys.forEach(key => { $(key).value = ""; });
  $("config-token").value = ""; autoFilledToken = ""; credentialWarning = "";
  message("command-notice", "");
  render(); drawTrends();
}

async function sendCommand(input, label) {
  if (!client || busy || review) return;
  let params;
  try { params = validateParams(input); } catch (error) { message("command-notice", error.message, "error"); return; }
  const target = client, epoch = generation, scope = new RequestScope(25000, "本次等待已超时；控制可能已执行，请先核对设备");
  cancelReads(); activeControl = scope; busy = true;
  message("command-notice", ""); put("progress-label", "检查在线状态 → 下发一次 → 核对51新回报"); render();
  try {
    const result = await target.control(params, {
      scope, onSending: persistReview,
      onUpdate: data => { if (epoch === generation) { currentData = data; networkError = ""; recordSamples(data); render(); } },
    });
    scope.assertActive();
    if (epoch !== generation) return;
    if (!result.confirmed) throw new PublicError("设备状态尚未确认，请刷新核对");
    currentData = result; networkError = ""; clearReview();
    message("command-notice", `${label}，已核对51新的实际回报。`, "success"); addLog(label, true);
  } catch (error) {
    if (epoch !== generation) return;
    const text = error instanceof PublicError ? error.message : "操作未确认，请刷新核对设备状态";
    message("command-notice", text, "error"); addLog(text, false);
  } finally {
    scope.close(); if (activeControl === scope) activeControl = null;
    busy = false; render();
    // Read-only recovery, never retry the write.
    if (epoch === generation && client) void refresh();
  }
}

function bind() {
  const openConfig = () => { message("config-error", ""); fillSavedToken(); $("config-dialog").showModal(); };
  $("config-open").addEventListener("click", openConfig);
  $("welcome-connect").addEventListener("click", openConfig);
  $("config-close").addEventListener("click", () => { $("config-token").value = ""; autoFilledToken = ""; $("config-dialog").close(); });
  $("config-dialog").addEventListener("cancel", () => { $("config-token").value = ""; autoFilledToken = ""; });
  for (const id of ["config-product", "config-device"]) $(id).addEventListener("input", fillSavedToken);
  $("config-token").addEventListener("input", () => { autoFilledToken = ""; });
  $("config-clear-token").addEventListener("click", () => {
    if (busy) return;
    try {
      forgetSavedToken(); disconnect(); updateSavedTokenStatus();
      message("config-error", "已清除保存的Token，并已断开连接；产品ID和设备名称保留。", "success");
    } catch { message("config-error", "未能清除已保存Token，请检查此站点存储权限后重试。", "error"); }
  });
  $("disconnect").addEventListener("click", () => { disconnect(); $("config-dialog").close(); });
  $("config-form").addEventListener("submit", event => {
    event.preventDefault(); if (busy) return;
    try {
      const config = { product: $("config-product").value, device: $("config-device").value, token: $("config-token").value };
      const next = new OneNetClient(config);
      const remembered = rememberConfig(next);
      disconnect(); client = next; reviewKey = `shixu.pages.review.v1.${next.identity()}`;
      readReview();
      credentialWarning = remembered ? "" : "本次仅临时使用Token：浏览器未能保存，下次仍需输入，请检查此站点存储权限。";
      $("config-token").value = ""; $("config-dialog").close();
      render(); void refresh();
    } catch (error) { message("config-error", error instanceof PublicError ? error.message : "连接配置无效", "error"); }
  });
  $("refresh").addEventListener("click", () => void refresh());
  $("review-refresh").addEventListener("click", async () => {
    if (pollPromise) await pollPromise;
    await refresh({ reviewRead: true }); render();
  });
  $("review-clear").addEventListener("click", () => {
    if ($("review-clear").disabled) return;
    try { clearReview(); message("command-notice", "已解除待核对提示；没有补发或重试任何命令。"); render(); }
    catch (error) { message("command-notice", error.message, "error"); }
  });
  $("cancel-wait").addEventListener("click", () => activeControl?.cancel("已结束网页等待；设备可能仍会执行，请刷新核对。结束等待不是停机"));
  draftKeys.forEach(key => $(key).addEventListener("input", () => dirty.add(key)));
  $("reload-drafts").addEventListener("click", () => { dirty.clear(); loadDrafts(liveSnapshot(currentData), true); });
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const selectTab = tab => tabs.forEach(item => {
    const selected = item === tab; item.setAttribute("aria-selected", String(selected)); item.tabIndex = selected ? 0 : -1;
    $(item.getAttribute("aria-controls")).hidden = !selected;
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); selectTab(tabs[next]); tabs[next].focus(); }
    });
  });
  $("time-form").addEventListener("submit", event => {
    event.preventDefault();
    const time = $("draft-time").value;
    void sendCommand({ DeviceTime: `${$("draft-date").value} ${time.length === 5 ? time + ":00" : time}` }, "日期时间已写入");
  });
  $("sync-time").addEventListener("click", () => {
    const d = new Date(Date.now() + 8 * 3600000), value = d.toISOString().slice(0, 19).replace("T", " ");
    void sendCommand({ DeviceTime: value }, "北京时间已同步");
  });
  $("temperature-form").addEventListener("submit", event => { event.preventDefault(); void sendCommand({ TemperatureLow: Number($("draft-low").value), TemperatureHigh: Number($("draft-high").value) }, "温度范围已保存"); });
  $("humidity-form").addEventListener("submit", event => { event.preventDefault(); void sendCommand({ HumidityLow: Number($("draft-h-low").value), HumidityHigh: Number($("draft-h-high").value) }, "湿度范围已保存"); });
  $("mute").addEventListener("click", () => void sendCommand({ AlarmMuted: true }, "已临时消音"));
  $("unmute").addEventListener("click", () => void sendCommand({ AlarmMuted: false }, "已恢复声音"));
  document.querySelectorAll("[data-motor]").forEach(button => button.addEventListener("click", () => void sendCommand({ MotorTarget: Number(button.dataset.motor) }, `电机已切到${MOTOR_NAMES[Number(button.dataset.motor)]}`)));
  $("load-history").addEventListener("click", async () => {
    if (!client || busy || historyBusy) return;
    const target = client, epoch = generation, scope = new RequestScope(8500, "历史读取等待超时，实时监测不受影响");
    historyScope = scope; historyBusy = true; render(); put("history-note", "正在读取OneNET历史；实时监测继续运行。");
    try {
      const result = await target.readHistory(scope); scope.assertActive();
      if (epoch !== generation) return;
      environment = result; historyMode = true; drawTrends();
      put("history-mode", "OneNET最近一小时 · 每项最多120个真实记录");
      put("history-note", `温度 ${result.temperature.length} 点 / 湿度 ${result.humidity.length} 点。较长缺报处断线，不补点；点按钮重新读取。`);
    } catch (error) {
      if (epoch === generation) put("history-note", error instanceof PublicError ? error.message : "历史读取失败，实时监测不受影响");
    } finally {
      scope.close(); if (historyScope === scope) { historyScope = null; historyBusy = false; render(); }
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && client) void refresh(); });
  window.addEventListener("online", () => { if (client) void refresh(); });
  window.addEventListener("offline", () => {
    if (!client) return;
    pollScope?.cancel("浏览器已离线，请检查网络后刷新");
    activeControl?.cancel("浏览器已离线；控制可能已执行，请重新联网后核对。断网不会自动停机");
    currentData = { ...currentData, gateway_status: 0 }; alcoholGap = true; networkError = "浏览器已离线；网络断开不会自动停机。";
    render();
  });
  window.addEventListener("pagehide", () => { cancelReads(); activeControl?.cancel("页面已离开，请重新打开后核对实际状态"); client?.forget(); $("config-token").value = ""; autoFilledToken = ""; });
  window.addEventListener("pageshow", event => { if (event.persisted && client) disconnect(); });
}

loadSavedConfig(); bind(); render(); drawTrends();
// No network, automatic control or configured secrets on initial load.
setInterval(() => { if (client && !document.hidden && !busy) void refresh(); }, 5000);
setInterval(() => { if (client && !document.hidden) render(); }, 1000);
