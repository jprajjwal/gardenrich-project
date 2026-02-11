// DELETE: let cartTotal = 0; 
// DELETE: function updateCartCount() { ... }

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