// SVG presentation only. Does not request, store or control any device state.
const PROFILE = [0, 40, 50, 60];
const point = (degree, radius = 101) => {
  const radians = degree * Math.PI / 180;
  return [165 + Math.cos(radians) * radius, 126 + Math.sin(radians) * radius];
};
const arc = (start, end, radius = 101) => {
  const a = point(start, radius), b = point(end, radius);
  return `M${a.join(",")} A${radius},${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${b.join(",")}`;
};

export function motorDialSpec(state) {
  const valid = state.motor_valid === true && Number.isInteger(state.motor_level) &&
    state.motor_level >= 0 && state.motor_level < PROFILE.length &&
    state.motor_pwm === PROFILE[state.motor_level];
  const pwm = valid ? state.motor_pwm : null;
  return {
    valid, pwm, end: valid ? 150 + 240 * pwm / 100 : null,
    label: valid ? `PWM占空比${pwm}%，刻度0至100%，最高设定60%；不是实测转速` : "等待有效PWM回报，刻度0至100%，最高设定60%；不是实测转速",
  };
}

export function drawMotorDial(root, state) {
  const spec = motorDialSpec(state);
  const node = (tag, attrs, text) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const children = [node("path", { d: arc(150, 390), fill:"none", stroke:"#e2ead9", "stroke-width":7, "stroke-linecap":"round" })];
  if (spec.valid && spec.pwm > 0) children.push(node("path", { d:arc(150, spec.end), fill:"none", stroke:"#779b69", "stroke-width":7, "stroke-linecap":"round", "data-part":"progress" }));
  for (let i = 0; i <= 20; i++) {
    const degree = 150 + 240 * i / 20, a = point(degree, 111), b = point(degree, i % 5 === 0 ? 119 : 115);
    children.push(node("line", { x1:a[0], y1:a[1], x2:b[0], y2:b[1], stroke:spec.valid && i <= spec.pwm / 5 ? "#a9bc94" : "#d4dfc9", "stroke-width":i % 5 === 0 ? 1.3 : .8 }));
  }
  for (const value of [0, 100]) {
    const [x, y] = point(150 + 240 * value / 100, 129);
    children.push(node("text", { x, y:y + 3, fill:"#81916f", "font-size":10, "text-anchor":"middle" }, `${value}%`));
  }
  const a = point(294, 94), b = point(294, 107);
  children.push(node("line", { x1:a[0], y1:a[1], x2:b[0], y2:b[1], stroke:"#b49a65", "stroke-width":2, "data-part":"limit-60" }));
  if (spec.valid) {
    const [x, y] = point(spec.end);
    children.push(node("circle", { cx:x, cy:y, r:6, fill:"#fffef9", stroke:"#688d58", "stroke-width":2, "data-part":"marker" }));
  }
  root.replaceChildren(...children);
  root.setAttribute("aria-label", spec.label);
  root.setAttribute("data-pwm-state", spec.valid ? "valid" : "unknown");
}
