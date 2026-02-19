function showCounter(btn) {
  const parent = btn.closest(".product");
  const productId = parent.getAttribute("data-id");
  const counter = parent.querySelector(".counter-control");
  const qtySpan = parent.querySelector(".qty-text");

  btn.classList.add("hidden");
  counter.classList.remove("hidden");
  counter.classList.add("flex");
  qtySpan.innerText = "1";

  fetch("/cart/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId }),
  })
    .then((res) => res.json())
    .then((data) => {
      const badge = document.getElementById("cartCount");
      if (badge) {
        badge.innerText = data.totalItems;
        badge.classList.remove("hidden");
        badge.classList.add("scale-110");
        setTimeout(() => badge.classList.remove("scale-110"), 200);
      }
    })
    .catch((err) => console.error("Cart add failed:", err));
}

function updateQty(btn, change) {
  const parent = btn.closest(".product");
  const productId = parent.getAttribute("data-id");
  const qtySpan = parent.querySelector(".qty-text");
  let currentQty = parseInt(qtySpan.innerText);

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

function updateCartQty(btn, change) {
  const itemContainer = btn.closest("[data-price]");
  const productId = itemContainer.getAttribute("data-id");
  const qtySpan = itemContainer.querySelector(".qty-text");

  let currentQty = parseInt(qtySpan.innerText);
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
      badge.classList.remove("hidden");
      if (data.totalItems === 0) badge.classList.add("hidden");
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
    total += price * qty;
  });

  const totalElements = document.querySelectorAll(
    "#cartTotal, #summaryOrderTotal, #summaryFinalTotal",
  );
  totalElements.forEach((el) => {
    el.innerText = "Rs. " + total.toLocaleString("en-IN");
  });
}

function checkEmptyCart() {
  const items = document.querySelectorAll("[data-price]");
  if (items.length === 0) {
    location.reload();
  }
}

function toggleUserMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById("userMenu");
  if (menu) {
    menu.classList.toggle("hidden");
  }
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

async function deleteProduct(productId, imageUrl) {
  if (!confirm("Are you sure you want to delete this product?")) return;

  try {
    const response = await fetch(`/admin/delete-product/${productId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl }),
    });

    if (response.ok) {
      document.querySelector(`[data-id="${productId}"]`).remove();
    } else {
      const errorData = await response.json();
      alert("Error: " + errorData.error);
    }
  } catch (err) {
    console.error("Delete error:", err);
    alert("Server communication error.");
  }
}

function openEditModal(id, name, price, weight, image) {
  document.getElementById("editProductId").value = id;
  document.getElementById("editName").value = name;
  document.getElementById("editPrice").value = price;
  document.getElementById("editWeight").value = weight;

  const preview = document.getElementById("editImagePreview");
  preview.src = image;
  preview.classList.remove("hidden");

  document.getElementById("editImage").addEventListener("change", function () {
    const file = this.files[0];
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.classList.remove("hidden");
    }
  });

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
    const price = document.getElementById("editPrice").value;
    const weight = document.getElementById("editWeight").value;
    const imageFile = document.getElementById("editImage").files[0];

    console.log("Submitting edit for ID:", id);

    const formData = new FormData();
    formData.append("name", name);
    formData.append("price", price);
    formData.append("weight", weight);
    if (imageFile) formData.append("imageFile", imageFile);

    const response = await fetch(`/admin/edit-product/${id}`, {
        method: "POST",
        body: formData,
    });

    const data = await response.json();
    console.log("Edit response:", data);

    if (response.ok) {
        closeEditModal();
        location.reload();
    } else {
        alert("Error: " + data.error);  // ← shows actual error message now
    }
}

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
