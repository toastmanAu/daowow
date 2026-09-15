"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const { selection, formatCkb } = window.DaowowEntry;
  const quantity = $("quantity");
  const presets = [...document.querySelectorAll("[data-quantity]")];
  function update() {
    let value;
    try { value = selection(quantity.value); } catch (error) {
      $("quantity-error").textContent = error.message;
      quantity.setAttribute("aria-invalid", "true");
      $("principal").textContent = "—";
      $("review").disabled = true;
      $("decrease").disabled = true;
      $("increase").disabled = true;
      presets.forEach(button => button.setAttribute("aria-pressed", "false"));
      return null;
    }
    $("quantity-error").textContent = "";
    quantity.removeAttribute("aria-invalid");
    $("principal").textContent = `${formatCkb(value.principal)} CKB`;
    $("review").disabled = false;
    $("decrease").disabled = value.tickets === 1;
    $("increase").disabled = value.tickets === 100;
    presets.forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.quantity) === value.tickets)));
    return value;
  }
  quantity.addEventListener("input", update);
  for (const button of presets) button.addEventListener("click", () => { quantity.value = button.dataset.quantity; update(); });
  for (const [id, delta] of [["decrease", -1], ["increase", 1]]) $(id).addEventListener("click", () => {
    const value = update();
    if (value) { quantity.value = String(Math.max(1, Math.min(100, value.tickets + delta))); update(); }
  });
  $("entry-form").addEventListener("submit", event => {
    event.preventDefault();
    const value = update();
    if (!value) { quantity.focus(); return; }
    $("review-quantity").textContent = String(value.tickets);
    $("review-principal").textContent = `${formatCkb(value.principal)} CKB`;
    $("review-dialog").showModal();
  });
  $("wallet").addEventListener("click", () => $("wallet-dialog").showModal());
  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  // Keep Tab navigation inside the modal instead of cycling into browser chrome.
  document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const controls = [...dialog.querySelectorAll("button:not(:disabled), a[href], input:not(:disabled), [tabindex='0']")];
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }));
  $("selection-controls").disabled = false;
  $("wallet").disabled = false;
  update();
})();
