const product = { name: "原味司康", price: 100, maxQuantity: 5 };
const storageKey = "scone-shop:v1";
const money = (amount) => `NT$${amount}`;
const all = (selector) => [...document.querySelectorAll(selector)];
let storageAvailable = true;

function totals(quantity) {
  const subtotal = quantity * product.price;
  const shipping = quantity === 0 || subtotal >= 300 ? 0 : 50;

  return { subtotal, shipping, total: subtotal + shipping };
}

function validQuantity(value) {
  return Number.isInteger(value) && value >= 0 && value <= product.maxQuantity;
}

function readQuantity(state) {
  const quantity = state?.quantity;

  return validQuantity(quantity) ? quantity : 0;
}

function validOrderId(id) {
  return typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
}

function validNote(note) {
  return typeof note === "string" && note.length <= 120;
}

function readOrder(order) {
  if (!order) {
    return null;
  }

  const checks = [
    validQuantity(order.quantity),
    order.quantity > 0,
    validOrderId(order.id),
    validNote(order.note),
  ];

  return checks.every(Boolean) ? order : null;
}

function readState() {
  const raw = localStorage.getItem(storageKey);
  let state;

  try {
    state = JSON.parse(raw);
  } catch {
    state = null;
  }

  return { quantity: readQuantity(state), order: readOrder(state?.order) };
}

function saveState(state) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function setText(selector, value) {
  all(selector).forEach((element) => {
    element.textContent = value;
  });
}

function feedback(message) {
  setText("[data-feedback]", message);
}

function storageError() {
  storageAvailable = false;
  all("button[data-action], button[data-submit]").forEach((button) => {
    button.disabled = true;
  });
  all("[data-storage-error]").forEach((element) => {
    element.hidden = false;
    element.textContent = "瀏覽器目前無法保存購物車。請允許此網站儲存資料後重新整理。";
  });
}

function renderOrder(order) {
  if (document.body.dataset.page !== "order") {
    return;
  }

  const requestedId = new URLSearchParams(location.search).get("order");
  const matches = order !== null && requestedId === order.id;
  all("[data-order-complete]").forEach((element) => {
    element.hidden = !matches;
  });
  all("[data-no-order]").forEach((element) => {
    element.hidden = matches;
  });

  if (!matches) {
    return;
  }

  const amounts = totals(order.quantity);
  setText("[data-order-id]", order.id);
  setText("[data-order-quantity]", order.quantity);
  setText("[data-order-subtotal]", money(amounts.subtotal));
  setText("[data-order-shipping]", money(amounts.shipping));
  setText("[data-order-total]", money(amounts.total));
  setText("[data-order-note]", order.note);
  all("[data-order-note-box]").forEach((element) => {
    element.hidden = order.note.length === 0;
  });
}

function render() {
  try {
    const state = readState();
    const { quantity } = state;
    const amounts = totals(quantity);
    setText("[data-cart-count], [data-quantity]", quantity);
    setText("[data-subtotal]", money(amounts.subtotal));
    setText("[data-shipping]", money(amounts.shipping));
    setText("[data-total]", money(amounts.total));
    all("[data-action]").forEach((button) => {
      const action = button.dataset.action;
      const disabled = {
        decrease: quantity === 0,
        checkout: quantity === 0,
        increase: quantity === product.maxQuantity,
        add: quantity === product.maxQuantity,
      };
      button.disabled = !storageAvailable || disabled[action];

      if (action === "add") {
        button.textContent =
          quantity === product.maxQuantity ? "已達上限 · 最多 5 顆" : "加入購物車 · NT$100";
      }
    });
    all("[data-submit]").forEach((button) => {
      button.disabled = !storageAvailable || quantity === 0;
    });
    all("[data-empty-cart], [data-empty-checkout]").forEach((element) => {
      element.hidden = quantity > 0;
    });
    all("[data-cart-item]").forEach((element) => {
      element.hidden = quantity === 0;
    });
    setText(
      "[data-shipping-message]",
      quantity === 0
        ? "加入 3 顆，就能享免運。"
        : amounts.shipping === 0
          ? "這筆訂單已享免運。"
          : `再加 ${3 - quantity} 顆，就能享免運。`,
    );
    renderOrder(state.order);
  } catch {
    storageError();
  }
}

function quantityMessage(quantity) {
  if (quantity === 0) {
    return "購物車是空的。加入一顆，開始你的午後。";
  }

  const detail = quantity === product.maxQuantity ? "已達每筆 5 顆上限。" : "數量與金額已更新。";

  return `購物車有 ${quantity} 顆原味司康。${detail}`;
}

function goToCheckout() {
  try {
    if (storageAvailable && readState().quantity > 0) {
      location.assign("checkout.html");
    }
  } catch {
    storageError();
  }
}

function changeQuantity(delta) {
  if (!storageAvailable) {
    return;
  }

  try {
    const state = readState();
    state.quantity = Math.max(0, Math.min(product.maxQuantity, state.quantity + delta));
    saveState(state);
    render();
    feedback(quantityMessage(state.quantity));
  } catch {
    storageError();
  }
}

all("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.action === "checkout") {
      goToCheckout();

      return;
    }

    changeQuantity(button.dataset.action === "decrease" ? -1 : 1);
  });
});

document.getElementById("checkout-form")?.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!storageAvailable) {
    return;
  }

  try {
    const state = readState();

    if (state.quantity === 0) {
      render();
      feedback("購物車是空的，請先加入商品再送出訂單。");

      return;
    }

    const note = document.getElementById("order-note").value.trim().slice(0, 120);
    const order = { id: crypto.randomUUID(), quantity: state.quantity, note };
    saveState({ quantity: 0, order });
    render();
    location.assign(`order.html?order=${encodeURIComponent(order.id)}`);
  } catch {
    storageError();
  }
});

window.addEventListener("pageshow", render);
window.addEventListener("storage", (event) => {
  if (event.key === storageKey || event.key === null) {
    render();
  }
});

try {
  saveState(readState());
  render();
} catch {
  storageError();
}
