// Presentation only: no API imports, credentials, timers, requests or device writes.
const panel = document.getElementById("settings");
const host = document.getElementById("settings-host");
const dialog = document.getElementById("settings-dialog");
const trigger = document.getElementById("settings-open");
const closeButton = document.getElementById("settings-close");
const compact = window.matchMedia("(max-width: 1599px)");
const links = [...document.querySelectorAll('.navigation a[href^="#"]')];
const summary = document.getElementById("control-summary");
const commandNotice = document.getElementById("command-notice");
const progress = document.getElementById("control-progress");
const review = document.getElementById("review-panel");

function updateControlSummary() {
  // Keep existing control results visible when their detailed panel is folded.
  let text = "", tone = "";
  if (!progress.hidden) text = document.getElementById("progress-label").textContent;
  else if (!review.hidden) { text = "有一条控制结果待核对，请查看详情。不要重复下发。"; tone = "error"; }
  else if (!commandNotice.hidden) { text = commandNotice.textContent; tone = commandNotice.classList.contains("error") ? "error" : commandNotice.classList.contains("success") ? "success" : ""; }
  summary.hidden = !compact.matches || dialog.open || !text;
  document.getElementById("control-summary-text").textContent = text;
  summary.className = `notice control-summary ${tone}`;
}

function highlight(id) {
  for (const link of links) {
    const selected = link.getAttribute("href") === `#${id}`;
    link.classList.toggle("active", selected);
    if (selected) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

function positionPanel() {
  if (dialog.open) dialog.close();
  (compact.matches ? dialog : host).append(panel);
  trigger.setAttribute("aria-haspopup", compact.matches ? "dialog" : "false");
  trigger.setAttribute("aria-expanded", "false");
  updateControlSummary();
}

function openSettings() {
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("settings-dialog-open");
  trigger.setAttribute("aria-expanded", "true");
  highlight("settings");
  updateControlSummary();
}
trigger.addEventListener("click", event => {
  if (!compact.matches) return;
  event.preventDefault();
  openSettings();
});
document.getElementById("control-summary-open").addEventListener("click", openSettings);
closeButton.addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  document.body.classList.remove("settings-dialog-open");
  trigger.setAttribute("aria-expanded", "false");
  trigger.focus({ preventScroll: true });
  highlight(location.hash.slice(1) || "monitor");
  updateControlSummary();
});
dialog.addEventListener("click", event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
for (const link of links) link.addEventListener("click", () => {
  if (link !== trigger || !compact.matches) highlight(link.hash.slice(1));
});
compact.addEventListener("change", positionPanel);
positionPanel();
highlight(location.hash.slice(1) || "monitor");
const controlObserver = new MutationObserver(updateControlSummary);
for (const node of [commandNotice, progress, review]) controlObserver.observe(node, { attributes:true, childList:true, characterData:true, subtree:true });

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(entries => {
    if (dialog.open) return;
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (visible.length) highlight(visible[0].target.id);
  }, { rootMargin: "-10% 0px -65% 0px", threshold: 0 });
  for (const id of ["monitor", "expansion", "history"]) observer.observe(document.getElementById(id));
}
