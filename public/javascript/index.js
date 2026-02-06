function showCounter(btn) {
  const container = btn.parentElement;
  const counter = container.querySelector(".counter-control");

  btn.classList.add("hidden");
  counter.classList.remove("hidden");
  counter.classList.add("flex");
}

function updateQty(btn, change) {
  const counterControl = btn.parentElement;
  const qtySpan = counterControl.querySelector(".qty-text");
  let currentQty = parseInt(qtySpan.innerText);

  currentQty += change;

  if (currentQty < 1) {
    counterControl.classList.add("hidden");
    counterControl.classList.remove("flex");
    counterControl
      .parentElement
      .querySelector(".add-btn")
      .classList.remove("hidden");

    qtySpan.innerText = "1";
  } else {
    qtySpan.innerText = currentQty;
  }
}

//cart

let cartTotal = 0;

function updateCartCount() {
  document.getElementById("cartCount").innerText = cartTotal;
}

function showCounter(btn) {
  const container = btn.parentElement;
  const counter = container.querySelector(".counter-control");

  btn.classList.add("hidden");
  counter.classList.remove("hidden");
  counter.classList.add("flex");

  // first add = 1 item
  cartTotal += 1;
  updateCartCount();
}

function updateQty(btn, change) {
  const counterControl = btn.parentElement;
  const qtySpan = counterControl.querySelector(".qty-text");
  let currentQty = parseInt(qtySpan.innerText);

  currentQty += change;

  if (currentQty < 1) {
    // remove from cart
    counterControl.classList.add("hidden");
    counterControl.classList.remove("flex");
    counterControl
      .parentElement
      .querySelector(".add-btn")
      .classList.remove("hidden");

    qtySpan.innerText = "1";

    cartTotal -= 1;
  } else {
    qtySpan.innerText = currentQty;
    cartTotal += change;
  }

  updateCartCount();
}
