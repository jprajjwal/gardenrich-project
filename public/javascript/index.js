function showCounter(btn) {
    const parent = btn.closest('.product');
    const productId = parent.getAttribute('data-id');
    const counter = parent.querySelector(".counter-control");
    const qtySpan = parent.querySelector(".qty-text");

    // UI Feedback: Show the counter immediately
    btn.classList.add("hidden");
    counter.classList.remove("hidden");
    counter.classList.add("flex");
    qtySpan.innerText = "1";

    // 1. Send the update to the server.
    // 2. The server returns the NEW totalItems.
    // 3. updateCartOnServer updates the badge.
    updateCartOnServer(productId, 1);
}

function updateQty(btn, change) {
    const parent = btn.closest('.product');
    const productId = parent.getAttribute('data-id');
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

    // Always update the server and let it return the correct badge count
    updateCartOnServer(productId, currentQty);
}

async function updateCartOnServer(productId, quantity) {
    try {
        const response = await fetch('/cart/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId, quantity })
        });
        
        const data = await response.json();
        
        // Update the badge with the REAL total from the database
        const badge = document.getElementById('cartCount');
        if (badge) {
            badge.innerText = data.totalItems;
        }
    } catch (err) {
        console.error("Cart update failed:", err);
    }
}

function updateCartQty(btn, change) {
    // Look for the closest div that actually has the data-price attribute
    const itemContainer = btn.closest("[data-price]"); 
    const productId = itemContainer.getAttribute("data-id");
    const qtySpan = itemContainer.querySelector(".qty-text");

    let currentQty = parseInt(qtySpan.innerText);
    currentQty += change;

    // Prevent negative quantities
    if (currentQty < 0) return;

    // Update UI immediately for responsiveness
    qtySpan.innerText = currentQty;

    // Send to server
    updateCartOnServer(productId, currentQty);

    // If qty is 0, remove the item from the list
    if (currentQty === 0) {
        itemContainer.remove();
    }

    // Recalculate the summary
    updateOrderSummary();
}

function updateOrderSummary() {
    let total = 0;

    document.querySelectorAll("[data-price]").forEach(item => {
        const price = parseFloat(item.getAttribute("data-price"));
        const qty = parseInt(item.querySelector(".qty-text")?.innerText || 0);
        total += price * qty;
    });

    const totalElement = document.getElementById("cartTotal");
    if (totalElement) {
        totalElement.innerText = "Rs. " + total;
    }
}



function toggleUserMenu(event) {
    if (event) event.stopPropagation(); // Prevents the document click from closing it immediately
    const menu = document.getElementById("userMenu");
    if (menu) {
        menu.classList.toggle("hidden");
    }
}

document.addEventListener("click", function (e) {
    const menu = document.getElementById("userMenu");
    const button = document.getElementById("userButton");
    
    if (menu && !menu.contains(e.target) && !button.contains(e.target)) {
        menu.classList.add("hidden");
    }
});