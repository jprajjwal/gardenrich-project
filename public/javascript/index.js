/**
 * HOME PAGE: Product Grid Counter
 */
function showCounter(btn) {
    const parent = btn.closest('.product');
    const productId = parent.getAttribute('data-id');
    const counter = parent.querySelector(".counter-control");
    const qtySpan = parent.querySelector(".qty-text");

    // UI Feedback: Premium transitions
    btn.classList.add("hidden");
    counter.classList.remove("hidden");
    counter.classList.add("flex", "animate-in", "zoom-in-95", "duration-200");
    qtySpan.innerText = "1";

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

    updateCartOnServer(productId, currentQty);
}

/**
 * CART PAGE: Cart Item Management
 */
function updateCartQty(btn, change) {
    const itemContainer = btn.closest("[data-price]"); 
    const productId = itemContainer.getAttribute("data-id");
    const qtySpan = itemContainer.querySelector(".qty-text");

    let currentQty = parseInt(qtySpan.innerText);
    currentQty += change;

    if (currentQty < 0) return;

    // Optimistic UI update
    if (currentQty === 0) {
        // Soft remove animation
        itemContainer.style.opacity = '0';
        itemContainer.style.transform = 'scale(0.95)';
        itemContainer.style.transition = 'all 0.2s ease';
        setTimeout(() => {
            itemContainer.remove();
            updateOrderSummary();
            checkEmptyCart(); // Check if we should show "Cart is Empty" message
        }, 200);
    } else {
        qtySpan.innerText = currentQty;
        updateOrderSummary();
    }

    updateCartOnServer(productId, currentQty);
}

/**
 * CORE: Server Sync & Badge Update
 */
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
            // Add a little "pop" animation to the badge
            badge.classList.add("scale-110");
            setTimeout(() => badge.classList.remove("scale-110"), 200);
        }
    } catch (err) {
        console.error("Cart update failed:", err);
    }
}

/**
 * UTILS: Summary Calculation
 */
function updateOrderSummary() {
    let total = 0;

    document.querySelectorAll("[data-price]").forEach(item => {
        const price = parseFloat(item.getAttribute("data-price"));
        const qty = parseInt(item.querySelector(".qty-text")?.innerText || 0);
        total += price * qty;
    });

    // Update all elements with the 'cartTotal' ID (Summary and Final Total)
    const totalElements = document.querySelectorAll("#cartTotal, #summaryOrderTotal, #summaryFinalTotal");
    totalElements.forEach(el => {
        // Premium formatting: Rs. 1,200.00
        el.innerText = "Rs. " + total.toLocaleString('en-IN');
    });
}

function checkEmptyCart() {
    const items = document.querySelectorAll("[data-price]");
    if (items.length === 0) {
        location.reload(); // Simplest way to show the EJS "Empty Cart" state
    }
}

/**
 * UI: User Menu Dropdown
 */
function toggleUserMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById("userMenu");
    if (menu) {
        menu.classList.toggle("hidden");
        menu.classList.add("animate-in", "fade-in", "slide-in-from-top-2");
    }
}

document.addEventListener("click", function (e) {
    const menu = document.getElementById("userMenu");
    const button = document.getElementById("userButton");
    
    if (menu && !menu.contains(e.target) && !button.contains(e.target)) {
        menu.classList.add("hidden");
    }
});

