function shrinkToFit(element) {
  const minFontSize = Number(element.getAttribute("data-min-font-size") || "18");
  const maxSteps = 80;
  const computed = window.getComputedStyle(element);
  let fontSize = Number.parseFloat(computed.fontSize || "0");
  if (!Number.isFinite(fontSize) || fontSize <= 0) fontSize = 40;

  let steps = 0;
  while (steps < maxSteps) {
    const fits = element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1;
    if (fits) return;
    const next = Math.max(minFontSize, fontSize - 2);
    if (next === fontSize) return;
    fontSize = next;
    element.style.fontSize = `${fontSize}px`;
    steps += 1;
  }
}

function applyFit() {
  const shrinkElements = document.querySelectorAll("[data-fit='shrink']");
  shrinkElements.forEach(el => shrinkToFit(el));
}

window.addEventListener("load", () => {
  try {
    applyFit();
  } catch (e) {
    // ignore
  }
});
