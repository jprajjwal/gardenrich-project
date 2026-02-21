function showCounter(btn) {
  const parent = btn.closest(".product");
  const productId = parent.getAttribute("data-id");
  const counter = parent.querySelector(".counter-control");
  const qtySpan = parent.querySelector(".qty-text");
  const stock = parseInt(parent.getAttribute("data-stock") || "99");

  if (stock === 0) return;

  // Optimistically show counter
  btn.classList.add("hidden");
  counter.classList.remove("hidden");
  counter.classList.add("flex");
  qtySpan.innerText = "1";

  fetch("/cart/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId }),
  })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) {
        // Rollback UI — item is out of stock or error
        counter.classList.add("hidden");
        counter.classList.remove("flex");
        btn.classList.remove("hidden");
        // Update the card to show out of stock
        parent.setAttribute("data-stock", "0");
        const outOfStockBtn = parent.querySelector(".out-of-stock-btn");
        if (outOfStockBtn) {
          outOfStockBtn.classList.remove("hidden");
          btn.classList.add("hidden");
        }
        showStockPopup(0);
        return;
      }
      const badge = document.getElementById("cartCount");
      if (badge) {
        badge.innerText = data.totalItems;
        badge.classList.remove("hidden");
        badge.classList.add("scale-110");
        setTimeout(() => badge.classList.remove("scale-110"), 200);
      }
    })
    .catch((err) => {
      console.error("Cart add failed:", err);
      // Rollback on network error
      counter.classList.add("hidden");
      counter.classList.remove("flex");
      btn.classList.remove("hidden");
    });
}

function updateQty(btn, change) {
  const parent = btn.closest(".product");
  const productId = parent.getAttribute("data-id");
  const qtySpan = parent.querySelector(".qty-text");
  const stock = parseInt(parent.getAttribute("data-stock") || "99");
  let currentQty = parseInt(qtySpan.innerText);

  if (change > 0 && currentQty >= stock) {
    showStockPopup(stock);
    return;
  }

  currentQty += change;

  if (currentQty < 1) {
    parent.querySelector(".counter-control").classList.add("hidden");
    parent.querySelector(".counter-control").classList.remove("flex");
    parent.querySelector(".add-btn").classList.remove("hidden");
    currentQty = 0;
  } else {
    qtySpan.innerText = currentQty;
  }

  updateCartOnServer(productId, currentQty);
}

function showStockPopup(stock) {
  const existing = document.getElementById("stockPopup");
  if (existing) existing.remove();

  const msg = stock === 0
    ? "This item is out of stock."
    : `Only ${stock} item${stock === 1 ? "" : "s"} available in stock.`;

  const popup = document.createElement("div");
  popup.id = "stockPopup";
  popup.className =
    "fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-zinc-900 text-white text-sm font-bold px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3";
  popup.innerHTML = `
    <svg class="w-5 h-5 text-orange-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    </svg>
    ${msg}
  `;
  document.body.appendChild(popup);

  setTimeout(() => {
    popup.style.opacity = "0";
    popup.style.transition = "opacity 0.3s ease";
    setTimeout(() => popup.remove(), 300);
  }, 2500);
}

function updateCartQty(btn, change) {
  const itemContainer = btn.closest("[data-price]");
  const productId = itemContainer.getAttribute("data-id");
  const qtySpan = itemContainer.querySelector(".qty-text");
  const price = parseFloat(itemContainer.getAttribute("data-price"));
  const stock = parseInt(itemContainer.getAttribute("data-stock") || "99");

  let currentQty = parseInt(qtySpan.innerText);

  if (change > 0 && currentQty >= stock) {
    showStockPopup(stock);
    return;
  }

  currentQty += change;

  if (currentQty < 0) return;

  if (currentQty === 0) {
    itemContainer.style.opacity = "0";
    itemContainer.style.transform = "scale(0.95)";
    itemContainer.style.transition = "all 0.2s ease";
    setTimeout(() => {
      itemContainer.remove();
      updateOrderSummary();
      checkEmptyCart();
    }, 200);
  } else {
    qtySpan.innerText = currentQty;

    const subtotalEl = itemContainer.querySelector(".item-subtotal");
    if (subtotalEl) {
      subtotalEl.textContent =
        "Rs. " + (price * currentQty).toLocaleString("en-IN");
    }

    const summaryQty = document.querySelector(
      `#summary-row-${productId} .summary-item-qty`
    );
    if (summaryQty) {
      summaryQty.textContent = "×" + currentQty;
    }

    const summaryLine = document.querySelector(
      `.summary-item-total[data-id="${productId}"]`
    );
    if (summaryLine) {
      summaryLine.textContent =
        "Rs. " + (price * currentQty).toLocaleString("en-IN");
    }

    updateOrderSummary();
  }

  updateCartOnServer(productId, currentQty);
}

async function updateCartOnServer(productId, quantity) {
  try {
    const response = await fetch("/cart/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, quantity }),
    });

    const data = await response.json();

    const badge = document.getElementById("cartCount");
    if (badge) {
      badge.innerText = data.totalItems;
      if (data.totalItems === 0) {
        badge.classList.add("hidden");
      } else {
        badge.classList.remove("hidden");
      }
      badge.classList.add("scale-110");
      setTimeout(() => badge.classList.remove("scale-110"), 200);
    }
  } catch (err) {
    console.error("Cart update failed:", err);
  }
}

function updateOrderSummary() {
  let total = 0;

  document.querySelectorAll("[data-price]").forEach((item) => {
    const price = parseFloat(item.getAttribute("data-price"));
    const qty = parseInt(item.querySelector(".qty-text")?.innerText || 0);
    if (!isNaN(price) && !isNaN(qty)) {
      total += price * qty;
    }
  });

  const formatted = "Rs. " + total.toLocaleString("en-IN");

  const els = document.querySelectorAll(
    "#summaryOrderTotal, #summaryFinalTotal, #cartTotal"
  );
  els.forEach((el) => {
    if (el) el.innerText = formatted;
  });
}

function checkEmptyCart() {
  const items = document.querySelectorAll("[data-price]");
  if (items.length === 0) location.reload();
}

function toggleUserMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("userMenu");
  if (menu) menu.classList.toggle("hidden");
}

document.addEventListener("click", function (e) {
  const menu = document.getElementById("userMenu");
  const button = document.getElementById("userButton");
  if (
    menu &&
    button &&
    !menu.contains(e.target) &&
    !button.contains(e.target)
  ) {
    menu.classList.add("hidden");
  }
});

// ── Delete modal ──────────────────────────────────────────────
function confirmDelete(productId, imageUrl) {
  document.getElementById("deleteProductId").value = productId;
  document.getElementById("deleteImageUrl").value = imageUrl;
  const modal = document.getElementById("deleteModal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeDeleteModal() {
  const modal = document.getElementById("deleteModal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

async function confirmDeleteAction() {
  const productId = document.getElementById("deleteProductId").value;
  const imageUrl = document.getElementById("deleteImageUrl").value;

  closeDeleteModal();

  try {
    const response = await fetch(`/admin/delete-product/${productId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl }),
    });

    if (response.ok) {
      const card = document.querySelector(`[data-id="${productId}"]`);
      if (card) {
        card.style.opacity = "0";
        card.style.transform = "scale(0.95)";
        card.style.transition = "all 0.3s ease";
        setTimeout(() => card.remove(), 300);
      }
    } else {
      const errorData = await response.json();
      alert("Error: " + errorData.error);
    }
  } catch (err) {
    console.error("Delete error:", err);
    alert("Server communication error.");
  }
}

// ── Edit modal ────────────────────────────────────────────────
function openEditModal(productId) {
  // Read all data from the product card's data attributes — no inline JSON in onclick
  const card = document.querySelector(`.product[data-id="${productId}"]`);
  if (!card) { console.error("Card not found for id", productId); return; }

  const name = card.getAttribute("data-name") || "";
  const category = card.getAttribute("data-category") || "";
  const variantsRaw = card.getAttribute("data-variants") || "[]";

  let variants = [];
  try { variants = JSON.parse(variantsRaw); } catch(e) { console.error("Variant parse error", e); }

  document.getElementById("editProductId").value = productId;
  document.getElementById("editName").value = name;

  const categorySelect = document.getElementById("editCategory");
  if (categorySelect) categorySelect.value = category;

  const preview = document.getElementById("editImagePreview");
  preview.classList.add("hidden");
  preview.src = "";

  const imageInput = document.getElementById("editImage");
  const newImageInput = imageInput.cloneNode(true);
  imageInput.parentNode.replaceChild(newImageInput, imageInput);
  newImageInput.addEventListener("change", function () {
    const file = this.files[0];
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("hidden");
    }
  });

  // Render variant stock inputs
  const container = document.getElementById("editVariantStocks");
  if (container) {
    if (variants.length > 0) {
      container.innerHTML = variants.map(v => `
        <div class="flex items-center gap-3 bg-zinc-50 rounded-xl p-3">
          <span class="text-sm font-bold text-zinc-700 flex-1">${v.weight}</span>
          <div class="flex items-center gap-2">
            <label class="text-xs text-zinc-400 font-bold">Stock</label>
            <input type="number" value="${v.stock}" min="0" step="1"
              data-variant-id="${v.id}"
              class="variant-stock-input w-20 p-2 rounded-lg border border-zinc-200 text-sm font-bold text-center outline-none focus:border-green-500">
          </div>
        </div>
      `).join("");
    } else {
      container.innerHTML = '<p class="text-xs text-zinc-400">No variants found</p>';
    }
  }

  const modal = document.getElementById("editModal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeEditModal() {
  const modal = document.getElementById("editModal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

async function submitEdit() {
  const id = document.getElementById("editProductId").value;
  const name = document.getElementById("editName").value;
  const category = document.getElementById("editCategory").value;
  const imageFile = document.getElementById("editImage").files[0];

  const formData = new FormData();
  formData.append("name", name);
  formData.append("category", category);
  if (imageFile) formData.append("imageFile", imageFile);

  // Append variant stock values
  document.querySelectorAll(".variant-stock-input").forEach(input => {
    formData.append("variantId[]", input.getAttribute("data-variant-id"));
    formData.append("variantStock[]", input.value);
  });

  try {
    const response = await fetch(`/admin/edit-product/${id}`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json();

    if (response.ok) {
      closeEditModal();
      location.reload();
    } else {
      alert("Error: " + data.error);
    }
  } catch (err) {
    alert("Server communication error.");
    console.error(err);
  }
}

// ── Variant change ────────────────────────────────────────────
function onVariantChange(select) {
  const card = select.closest(".product");
  const selected = select.options[select.selectedIndex];

  const price = selected.getAttribute("data-price");
  const mrp = selected.getAttribute("data-mrp");
  const stock = parseInt(selected.getAttribute("data-stock") || "0");

  card.querySelector(".variant-price").textContent = `Rs. ${price}`;
  card.setAttribute("data-price", price);
  card.setAttribute("data-stock", stock);

  const mrpEl = card.querySelector(".variant-mrp");
  const discountEl = card.querySelector(".variant-discount");

  if (mrp && parseFloat(mrp) > parseFloat(price)) {
    if (mrpEl) {
      mrpEl.textContent = `Rs. ${mrp}`;
      mrpEl.classList.remove("hidden");
    }
    if (discountEl) {
      const pct = Math.round(
        ((parseFloat(mrp) - parseFloat(price)) / parseFloat(mrp)) * 100
      );
      discountEl.textContent = `${pct}% OFF`;
      discountEl.classList.remove("hidden");
    }
  } else {
    if (mrpEl) mrpEl.classList.add("hidden");
    if (discountEl) discountEl.classList.add("hidden");
  }

  // Update add button / counter visibility based on new variant stock
  const addBtn = card.querySelector(".add-btn");
  const counter = card.querySelector(".counter-control");
  const qtySpan = card.querySelector(".qty-text");
  const outOfStockBtn = card.querySelector(".out-of-stock-btn");

  if (outOfStockBtn) {
    if (stock === 0) {
      outOfStockBtn.classList.remove("hidden");
      if (addBtn) addBtn.classList.add("hidden");
    } else {
      outOfStockBtn.classList.add("hidden");
      if (addBtn) addBtn.classList.remove("hidden");
    }
  }

  // Reset quantity counter when variant changes
  if (counter && !counter.classList.contains("hidden")) {
    counter.classList.add("hidden");
    counter.classList.remove("flex");
    if (addBtn) addBtn.classList.remove("hidden");
    if (qtySpan) qtySpan.innerText = "1";
  }
}

// ── Address helpers ───────────────────────────────────────────
function selectAddress(label) {
  document.querySelectorAll('[name="selected_address"]').forEach((r) => {
    r.closest("label").classList.remove("border-green-600", "bg-green-50");
    r.closest("label").classList.add("border-zinc-200", "bg-white");
  });
  label.classList.add("border-green-600", "bg-green-50");
  label.classList.remove("border-zinc-200", "bg-white");
}

function showNewAddressForm() {
  document.getElementById("newAddressForm").classList.remove("hidden");
  document.getElementById("savedAddresses").classList.add("hidden");
  document.getElementById("addNewBtn").classList.add("hidden");
}

function cancelNewAddress() {
  document.getElementById("newAddressForm").classList.add("hidden");
  document.getElementById("savedAddresses").classList.remove("hidden");
  document.getElementById("addNewBtn").classList.remove("hidden");
}

// ── Admin order status ────────────────────────────────────────
async function updateStatus(orderId, select) {
  const status = select.value;
  const card = select.closest(".order-card");
  const badge = card.querySelector(".status-badge");

  const response = await fetch("/admin/orders/update-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, status }),
  });

  if (response.ok) {
    badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    const colorMap = {
      pending: "bg-yellow-100 text-yellow-700",
      confirmed: "bg-blue-100 text-blue-700",
      shipped: "bg-purple-100 text-purple-700",
      delivered: "bg-green-100 text-green-700",
      cancelled: "bg-red-100 text-red-700",
    };
    badge.className = `status-badge text-xs font-black px-3 py-1 rounded-full ${colorMap[status]}`;
    card.setAttribute("data-status", status);
  } else {
    alert("Failed to update status.");
    select.value = card.getAttribute("data-status");
  }
}

function filterOrders(status) {
  const cards = document.querySelectorAll(".order-card");
  cards.forEach((card) => {
    if (status === "all" || card.getAttribute("data-status") === status) {
      card.classList.remove("hidden");
    } else {
      card.classList.add("hidden");
    }
  });

  document.querySelectorAll(".filter-tab").forEach((btn) => {
    btn.classList.remove("bg-zinc-900", "text-white");
    btn.classList.add("bg-white", "text-zinc-600", "border", "border-zinc-200");
  });

  const activeTab = document.getElementById(`tab-${status}`);
  activeTab.classList.add("bg-zinc-900", "text-white");
  activeTab.classList.remove(
    "bg-white",
    "text-zinc-600",
    "border",
    "border-zinc-200"
  );
}