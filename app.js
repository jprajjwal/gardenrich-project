const express = require("express");
const session = require("express-session");
const { createClient } = require("@supabase/supabase-js");
const app = express();
const path = require("path");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "prajjwalj02@gmail.com",
    pass: "iwxedcnijtuvtuzr",
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "gardenrich-secret-key",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

const supabaseUrl = "https://cqdtrsmoqeszhdmippzx.supabase.co";
const supabaseAnonKey = "sb_publishable_oCt8OHvgiR72BjjsIOkjbw_R386qFfY";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseAnonKey;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

app.set("view engine", "ejs");

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;

  let totalItems = 0;
  if (req.session.user) {
    const { data } = await supabase
      .from("carts")
      .select("quantity")
      .eq("user_id", req.session.user.id);

    if (data) {
      totalItems = data.reduce((acc, item) => acc + item.quantity, 0);
    }
  }

  res.locals.cartCount = totalItems;
  next();
});

// ── Helper: enrich cart rows with product + variant data ─────
async function enrichCartItems(rawCart) {
  if (!rawCart || rawCart.length === 0) return [];

  const productIds = [...new Set(rawCart.map((r) => parseInt(r.product_id, 10)))].filter(Boolean);

  const productResults = await Promise.all(
    productIds.map((pid) =>
      supabase.from("products").select("id, name, image, brand").eq("id", pid).maybeSingle()
    )
  );

  const variantResults = await Promise.all(
    productIds.map((pid) =>
      supabase
        .from("product_variants")
        .select("id, product_id, price, weight, mrp, stock")
        .eq("product_id", pid)
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle()
    )
  );

  productResults.forEach(({ error }, i) => {
    if (error) console.error(`Product fetch error for id ${productIds[i]}:`, error.message);
  });
  variantResults.forEach(({ error }, i) => {
    if (error) console.error(`Variant fetch error for product_id ${productIds[i]}:`, error.message);
  });

  const productMap = {};
  productResults.forEach(({ data }) => {
    if (data) productMap[parseInt(data.id, 10)] = data;
  });

  const variantMap = {};
  variantResults.forEach(({ data }) => {
    if (data) variantMap[parseInt(data.product_id, 10)] = data;
  });

  return rawCart.map((item) => {
    const pid = parseInt(item.product_id, 10);
    const product = productMap[pid] || {};
    const variant = variantMap[pid] || {};
    return {
      ...item,
      variant_id: variant.id || null,
      price: variant.price || 0,
      weight: variant.weight || "",
      mrp: variant.mrp || null,
      stock: variant.stock !== undefined ? variant.stock : 99,
      product_name: product.name || "",
      product_image: product.image || "",
      product_brand: product.brand || "",
    };
  });
}

// ── Home ──────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  try {
    const searchQuery = req.query.search;
    const activeCategory = req.query.category || "all";

    const { data: categories } = await supabase.from("categories").select("*");

    let queryBuilder = supabase
      .from("products")
      .select("*, product_variants(*)");

    if (searchQuery) queryBuilder = queryBuilder.ilike("name", `%${searchQuery}%`);
    if (activeCategory && activeCategory !== "all") {
      queryBuilder = queryBuilder.eq("category", activeCategory);
    }

    const { data: products, error } = await queryBuilder;
    if (error) throw error;

    let cartMap = {};
    if (req.session.user) {
      const { data: cartItems } = await supabase
        .from("carts")
        .select("product_id, quantity")
        .eq("user_id", req.session.user.id);

      if (cartItems) {
        cartItems.forEach((item) => {
          cartMap[item.product_id] = item.quantity;
        });
      }
    }

    res.render("index", {
      products: products || [],
      query: searchQuery || "",
      cartMap,
      categories: categories || [],
      activeCategory,
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).send("Error fetching products");
  }
});

// ── Auth ──────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  res.render("login", {
    error: req.query.error || null,
    email: req.query.email || "",
  });
});

// FIX: was router.post (router undefined) — changed to app.post
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      const msg = error.message.toLowerCase();
      let errorCode = "unknown";

      if (
        msg.includes("invalid login credentials") ||
        msg.includes("invalid email or password") ||
        msg.includes("email not confirmed")
      ) {
        errorCode = "invalid_credentials";
      } else if (msg.includes("user not found")) {
        errorCode = "user_not_found";
      } else if (msg.includes("disabled") || msg.includes("banned")) {
        errorCode = "account_disabled";
      }

      return res.redirect(`/login?error=${errorCode}&email=${encodeURIComponent(email)}`);
    }

    // Fetch profile to get role
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", data.user.id)
      .single();

    req.session.user = {
      id: data.user.id,
      email: data.user.email,
      name: profile?.name || "",
      role: profile?.role || "USER",
    };

    return res.redirect("/");
  } catch (err) {
    console.error("Login error:", err);
    return res.redirect(`/login?error=unknown&email=${encodeURIComponent(email)}`);
  }
});

function isAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "ADMIN") {
    return res.status(403).send("Access Denied");
  }
  next();
}

app.get("/signup", (req, res) => res.render("signup"));

app.post("/signup", async (req, res) => {
  const { name, email, password, mobile } = req.body;

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    console.error("Signup Error:", error.message);
    return res.send("Signup failed: " + error.message);
  }

  const user = data.user;

  const { error: profileError } = await supabase.from("profiles").insert([
    { id: user.id, name, email, mobile },
  ]);

  if (profileError) console.error("Profile Error:", profileError.message);

  req.session.user = {
    id: user.id,
    email: user.email,
    name: name,
    role: "USER",
  };

  res.redirect("/");
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ── Admin ─────────────────────────────────────────────────────
app.get("/admin", isAdmin, async (req, res) => {
  const { data: categories } = await supabase.from("categories").select("*");
  res.render("admin", { categories: categories || [] });
});

app.post("/admin/add-product", isAdmin, upload.single("imageFile"), async (req, res) => {
  try {
    const { name, brand, description, category, is_featured } = req.body;
    const file = req.file;

    if (!file) return res.status(400).send("Please upload an image.");

    const fileName = `${Date.now()}-${file.originalname}`;
    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from("product-images")
      .getPublicUrl(fileName);

    const publicImageUrl = urlData.publicUrl;

    const { data: product, error: productError } = await supabase
      .from("products")
      .insert([{
        name,
        category: category || "all",
        is_featured: is_featured === "true",
        image: publicImageUrl,
      }])
      .select()
      .single();

    if (productError) throw productError;

    const rawWeights = req.body["weightValue[]"] || req.body.weightValue;
    const rawUnits = req.body["unit[]"] || req.body.unit;
    const rawPrices = req.body["price[]"] || req.body.price;
    const rawMrps = req.body["mrp[]"] || req.body.mrp;
    const rawStocks = req.body["stock[]"] || req.body.stock;

    const weightValues = Array.isArray(rawWeights) ? rawWeights : [rawWeights];
    const units = Array.isArray(rawUnits) ? rawUnits : [rawUnits];
    const prices = Array.isArray(rawPrices) ? rawPrices : [rawPrices];
    const mrps = Array.isArray(rawMrps) ? rawMrps : [rawMrps];
    const stocks = Array.isArray(rawStocks) ? rawStocks : [rawStocks];

    const validVariants = weightValues
      .map((val, i) => ({
        weight: val,
        unit: units[i],
        price: prices[i],
        mrp: mrps[i],
        stock: stocks[i],
      }))
      .filter((v) => v.weight && v.unit && v.price);

    if (validVariants.length === 0) {
      return res.status(400).send("Please add at least one valid variant.");
    }

    const variantInserts = validVariants.map((v) => ({
      product_id: product.id,
      weight: `${v.weight} ${v.unit}`,
      price: parseFloat(v.price),
      mrp: v.mrp ? parseFloat(v.mrp) : null,
      stock: v.stock ? parseInt(v.stock) : 0,
    }));

    const { error: variantError } = await supabase
      .from("product_variants")
      .insert(variantInserts);

    if (variantError) throw variantError;

    res.redirect("/");
  } catch (err) {
    console.error("Upload Error:", err.message);
    res.status(500).send("Failed to add product: " + err.message);
  }
});

app.post("/admin/edit-product/:id", isAdmin, upload.single("imageFile"), async (req, res) => {
  try {
    const productId = parseInt(req.params.id);
    const { name, category } = req.body;

    let updateData = { name, category };

    if (req.file) {
      const fileName = `${Date.now()}-${req.file.originalname}`;
      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from("product-images")
        .getPublicUrl(fileName);

      updateData.image = urlData.publicUrl;
    }

    const { error } = await supabase
      .from("products")
      .update(updateData)
      .eq("id", productId);

    if (error) throw error;

    const rawVariantIds = req.body["variantId[]"] || req.body.variantId;
    const rawVariantStocks = req.body["variantStock[]"] || req.body.variantStock;

    if (rawVariantIds && rawVariantStocks) {
      const variantIds = Array.isArray(rawVariantIds) ? rawVariantIds : [rawVariantIds];
      const variantStocks = Array.isArray(rawVariantStocks) ? rawVariantStocks : [rawVariantStocks];

      await Promise.all(
        variantIds.map(async (vid, i) => {
          const newStock = parseInt(variantStocks[i], 10);
          if (isNaN(newStock) || newStock < 0) return;
          const variantId = parseInt(vid, 10);
          console.log(`Updating variant ${variantId} stock → ${newStock}`);

          const { error: rpcErr } = await supabase.rpc("update_variant_stock", {
            p_variant_id: variantId,
            p_new_stock: newStock,
          });

          if (rpcErr) {
            console.error(`RPC failed for variant ${variantId}: ${rpcErr.message} — trying direct update`);
            const { error: directErr } = await supabase
              .from("product_variants")
              .update({ stock: newStock })
              .eq("id", variantId);
            if (directErr) console.error(`Direct update also failed: ${directErr.message}`);
          }
        })
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Edit Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/admin/delete-product/:id", isAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const { imageUrl } = req.body;

    const { error: dbError } = await supabase
      .from("products")
      .delete()
      .eq("id", productId);

    if (dbError) throw dbError;

    if (imageUrl && imageUrl.includes("supabase.co")) {
      const fileName = imageUrl.split("/").pop();
      await supabase.storage.from("product-images").remove([fileName]);
    }

    res.status(200).json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Delete Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/orders", isAdmin, async (req, res) => {
  const { data: orders } = await supabase
    .from("orders")
    .select("*, addresses(*), order_items(*)")
    .order("created_at", { ascending: false });

  const today = new Date().toISOString().split("T")[0];
  const thisMonth = new Date().toISOString().slice(0, 7);

  const todayOrders = orders?.filter((o) => o.created_at.startsWith(today)) || [];
  const thisMonthOrders = orders?.filter((o) => o.created_at.startsWith(thisMonth)).length || 0;
  const thisMonthRevenue =
    orders
      ?.filter((o) => o.created_at.startsWith(thisMonth))
      .reduce((acc, o) => acc + o.total, 0) || 0;

  const monthlyStats = {};
  orders?.forEach((order) => {
    const month = order.created_at.slice(0, 7);
    if (!monthlyStats[month]) monthlyStats[month] = { count: 0, total: 0 };
    monthlyStats[month].count += 1;
    monthlyStats[month].total += order.total;
  });

  res.render("admin-orders", {
    orders: orders || [],
    todayOrders,
    thisMonthOrders,
    thisMonthRevenue,
    monthlyStats,
  });
});

app.post("/admin/orders/update-status", isAdmin, async (req, res) => {
  const { orderId, status } = req.body;

  const { error } = await supabase
    .from("orders")
    .update({ status })
    .eq("id", orderId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Cart ──────────────────────────────────────────────────────
app.get("/cart", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: rawCart } = await supabase
    .from("carts")
    .select("*")
    .eq("user_id", req.session.user.id);

  const enrichedCart = await enrichCartItems(rawCart || []);
  const total = enrichedCart.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const cartCount = enrichedCart.reduce((acc, item) => acc + item.quantity, 0);

  res.render("cart", { cartItems: enrichedCart, total, cartCount });
});

app.post("/cart/add", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });

  const { productId } = req.body;

  const { data: variants } = await supabase
    .from("product_variants")
    .select("stock, price")
    .eq("product_id", productId)
    .order("id", { ascending: true })
    .limit(1);

  const stock = variants?.[0]?.stock !== undefined ? variants[0].stock : 99;

  if (stock === 0) {
    return res.status(400).json({ error: "Out of stock", stock: 0 });
  }

  const { data: existing } = await supabase
    .from("carts")
    .select("*")
    .eq("user_id", req.session.user.id)
    .eq("product_id", productId)
    .single();

  if (existing) {
    const newQty = Math.min(existing.quantity + 1, stock);
    await supabase
      .from("carts")
      .update({ quantity: newQty })
      .eq("id", existing.id);
  } else {
    await supabase
      .from("carts")
      .insert([{ user_id: req.session.user.id, product_id: productId, quantity: 1 }]);
  }

  const { data: allItems } = await supabase
    .from("carts")
    .select("quantity")
    .eq("user_id", req.session.user.id);

  const totalItems = allItems?.reduce((acc, i) => acc + i.quantity, 0) || 0;
  res.json({ success: true, totalItems, stock });
});

app.post("/cart/update", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });

  const { productId, quantity } = req.body;

  if (quantity <= 0) {
    await supabase
      .from("carts")
      .delete()
      .eq("user_id", req.session.user.id)
      .eq("product_id", productId);
  } else {
    const { data: variants } = await supabase
      .from("product_variants")
      .select("stock")
      .eq("product_id", productId)
      .order("id", { ascending: true })
      .limit(1);

    const stock = variants?.[0]?.stock !== undefined ? variants[0].stock : 99;
    const safeQty = Math.min(quantity, stock);

    const { data: existing } = await supabase
      .from("carts")
      .select("id")
      .eq("user_id", req.session.user.id)
      .eq("product_id", productId)
      .single();

    if (existing) {
      await supabase
        .from("carts")
        .update({ quantity: safeQty })
        .eq("id", existing.id);
    } else {
      await supabase.from("carts").insert([
        { user_id: req.session.user.id, product_id: productId, quantity: safeQty },
      ]);
    }
  }

  const { data: allItems } = await supabase
    .from("carts")
    .select("quantity")
    .eq("user_id", req.session.user.id);

  const totalItems = allItems?.reduce((acc, i) => acc + i.quantity, 0) || 0;
  res.json({ success: true, totalItems });
});

// ── Checkout ──────────────────────────────────────────────────
app.get("/checkout", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: addresses } = await supabase
    .from("addresses")
    .select("*")
    .eq("user_id", req.session.user.id)
    .order("created_at", { ascending: false });

  const { data: rawCart } = await supabase
    .from("carts")
    .select("*")
    .eq("user_id", req.session.user.id);

  const cartItems = await enrichCartItems(rawCart || []);
  const total = cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0);

  res.render("checkout", { addresses: addresses || [], cartItems, total });
});

app.post("/checkout", async (req, res) => {
  try {
    if (!req.session.user) return res.redirect("/login");

    const { data: rawCart } = await supabase
      .from("carts")
      .select("*")
      .eq("user_id", req.session.user.id);

    if (!rawCart || rawCart.length === 0) {
      return res.redirect("/cart");
    }

    const cartItems = await enrichCartItems(rawCart);

    const stockErrors = cartItems.filter((item) => item.stock < item.quantity);
    if (stockErrors.length > 0) {
      const msgs = stockErrors
        .map((item) =>
          item.stock === 0
            ? `"${item.product_name}" is out of stock`
            : `"${item.product_name}" only has ${item.stock} left (you have ${item.quantity} in cart)`
        )
        .join(", ");
      return res.status(400).send(`Stock issue: ${msgs}. Please update your cart.`);
    }

    const total = cartItems.reduce(
      (acc, item) => acc + item.price * item.quantity,
      0
    );

    const {
      selected_address,
      first_name,
      last_name,
      address_phone,
      phone,
      address,
      city,
      pin_code,
      email,
    } = req.body;

    let addressId;
    if (selected_address) {
      addressId = selected_address;
    } else {
      const { data: newAddr, error: addrError } = await supabase
        .from("addresses")
        .insert([{
          user_id: req.session.user.id,
          first_name,
          last_name,
          phone: address_phone || phone,
          address,
          city,
          pin_code,
        }])
        .select()
        .single();

      if (addrError) throw addrError;
      addressId = newAddr.id;
    }

    const { data: addressData } = await supabase
      .from("addresses")
      .select("*")
      .eq("id", addressId)
      .single();

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([{
        user_id: req.session.user.id,
        address_id: addressId,
        email,
        phone,
        status: "pending",
        total,
      }])
      .select()
      .single();

    if (orderError) throw orderError;

    const orderItems = cartItems.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      product_image: item.product_image,
      quantity: item.quantity,
      price: item.price,
    }));

    await supabase.from("order_items").insert(orderItems);

    await Promise.all(
      cartItems.map(async (item) => {
        let variantId = item.variant_id;
        if (!variantId) {
          const { data: vLookup } = await supabase
            .from("product_variants")
            .select("id, stock")
            .eq("product_id", parseInt(item.product_id, 10))
            .order("id", { ascending: true })
            .limit(1)
            .maybeSingle();
          if (!vLookup) {
            console.error(`No variant found for product_id ${item.product_id} — skipping`);
            return;
          }
          variantId = vLookup.id;
        }

        const { data: vData, error: vErr } = await supabase
          .from("product_variants")
          .select("stock")
          .eq("id", variantId)
          .single();

        if (vErr || !vData) {
          console.error(`Stock read failed for variant ${variantId}:`, vErr?.message);
          return;
        }

        const newStock = Math.max(0, vData.stock - item.quantity);
        console.log(`Stock decrement: variant ${variantId}: ${vData.stock} → ${newStock}`);

        // Try RPC first
        const { error: fnErr } = await supabase.rpc("update_variant_stock", {
          p_variant_id: variantId,
          p_new_stock: newStock,
        });

        if (fnErr) {
          console.warn(`RPC failed for variant ${variantId}: ${fnErr.message} — using direct update`);
          // Direct update fallback — works when service key is set
          const { error: directErr } = await supabase
            .from("product_variants")
            .update({ stock: newStock })
            .eq("id", variantId);

          if (directErr) {
            console.error(`Direct stock update ALSO failed for variant ${variantId}: ${directErr.message}`);
          } else {
            console.log(`Direct stock update succeeded for variant ${variantId} → ${newStock}`);
          }
        }
      })
    );

    await supabase.from("carts").delete().eq("user_id", req.session.user.id);

    const buildItemsTable = (showUnitPrice) =>
      cartItems
        .map(
          (item) => `
          <tr>
            <td style="padding:10px;border-bottom:1px solid #f0f0f0;">
              <img src="${item.product_image}" width="50"
                style="border-radius:8px;vertical-align:middle;margin-right:10px;">
              ${item.product_name}
            </td>
            <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.weight}</td>
            <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.quantity}</td>
            ${showUnitPrice ? `<td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:right;">Rs. ${item.price.toLocaleString("en-IN")}</td>` : ""}
            <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:bold;">
              Rs. ${(item.price * item.quantity).toLocaleString("en-IN")}
            </td>
          </tr>`
        )
        .join("");

    const tableHeader = (showUnitPrice) => `
      <thead>
        <tr style="background:#f4f4f5;">
          <th style="padding:10px;text-align:left;font-size:12px;text-transform:uppercase;">Product</th>
          <th style="padding:10px;text-align:center;font-size:12px;text-transform:uppercase;">Size</th>
          <th style="padding:10px;text-align:center;font-size:12px;text-transform:uppercase;">Qty</th>
          ${showUnitPrice ? '<th style="padding:10px;text-align:right;font-size:12px;text-transform:uppercase;">Unit Price</th>' : ""}
          <th style="padding:10px;text-align:right;font-size:12px;text-transform:uppercase;">Total</th>
        </tr>
      </thead>`;

    await transporter.sendMail({
      from: '"GardenRich Orders" <prajjwalj02@gmail.com>',
      to: "sahilcingh@gmail.com",
      cc: "prajjwalj02@gmail.com",
      subject: `🛒 New Order #${order.id.toString().slice(0, 8)} — Rs. ${total.toLocaleString("en-IN")}`,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:0 auto;">
          <h2 style="background:#18181b;color:white;padding:20px;border-radius:12px 12px 0 0;margin:0;">
            New Order Received
          </h2>
          <div style="background:white;padding:20px;border:1px solid #f0f0f0;border-radius:0 0 12px 12px;">
            <p><strong>Customer:</strong> ${addressData.first_name} ${addressData.last_name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Phone:</strong> ${phone}</p>
            <p><strong>Address:</strong> ${addressData.address}, ${addressData.city} — ${addressData.pin_code}</p>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:16px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${tableHeader(true)}
              <tbody>${buildItemsTable(true)}</tbody>
            </table>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:16px 0;">
            <div style="text-align:right;">
              <p style="font-size:20px;font-weight:900;color:#16a34a;">
                Total: Rs. ${total.toLocaleString("en-IN")}
              </p>
              <p style="color:#888;font-size:12px;">Payment: Cash On Delivery</p>
            </div>
          </div>
        </div>`,
    });

    await transporter.sendMail({
      from: '"GardenRich" <prajjwalj02@gmail.com>',
      to: email,
      subject: `✅ Order Confirmed — Rs. ${total.toLocaleString("en-IN")}`,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:0 auto;">
          <h2 style="background:#16a34a;color:white;padding:20px;border-radius:12px 12px 0 0;margin:0;">
            Order Confirmed! 🎉
          </h2>
          <div style="background:white;padding:20px;border:1px solid #f0f0f0;border-radius:0 0 12px 12px;">
            <p>Hi <strong>${addressData.first_name}</strong>, your order has been placed successfully!</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${tableHeader(false)}
              <tbody>${buildItemsTable(false)}</tbody>
            </table>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:16px 0;">
            <p style="text-align:right;font-size:18px;font-weight:900;color:#16a34a;">
              Total: Rs. ${total.toLocaleString("en-IN")}
            </p>
            <p style="background:#f4f4f5;padding:12px;border-radius:8px;">
              <strong>Delivering to:</strong><br>
              ${addressData.address}, ${addressData.city} — ${addressData.pin_code}<br>
              ${addressData.phone}
            </p>
            <p style="color:#888;font-size:12px;text-align:center;margin-top:16px;">
              Payment: Cash On Delivery
            </p>
          </div>
        </div>`,
    });

    res.redirect(`/order-success?orderId=${order.id}`);
  } catch (err) {
    console.error("Checkout error:", err.message);
    res.status(500).send("Checkout failed: " + err.message);
  }
});

// ── Order success ─────────────────────────────────────────────
app.get("/order-success", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const orderId = req.query.orderId || req.query.id;

  if (!orderId) return res.redirect("/");

  const { data: order } = await supabase
    .from("orders")
    .select("*, addresses(*), order_items(*)")
    .eq("id", orderId)
    .single();

  if (!order) return res.redirect("/");

  res.render("order-success", { order });
});

// ── Profile ───────────────────────────────────────────────────
app.get("/profile", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", req.session.user.id)
    .single();

  if (error) {
    console.error("Error fetching profile:", error.message);
    return res.status(500).send("Could not load profile.");
  }

  res.render("profile", { profile });
});

app.post("/profile/update", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");

  const { name, mobile } = req.body;

  const { error } = await supabase
    .from("profiles")
    .update({ name, mobile })
    .eq("id", req.session.user.id);

  if (error) return res.status(500).send("Update failed: " + error.message);

  req.session.user.name = name;
  res.redirect("/profile");
});

// ── My Orders ─────────────────────────────────────────────────
app.get("/my-orders", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: orders } = await supabase
    .from("orders")
    .select("*, addresses(*), order_items(*)")
    .eq("user_id", req.session.user.id)
    .order("created_at", { ascending: false });

  res.render("my-orders", { orders: orders || [] });
});

app.get("/my-orders/:id", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: order } = await supabase
    .from("orders")
    .select("*, addresses(*), order_items(*)")
    .eq("id", req.params.id)
    .eq("user_id", req.session.user.id)
    .single();

  if (!order) return res.status(404).send("Order not found.");

  res.render("order-detail", { order });
});

// ── Static pages ──────────────────────────────────────────────
app.get("/privacy", (req, res) => res.render("privacy"));
app.get("/returns", (req, res) => res.render("refund"));
app.get("/terms", (req, res) => res.render("terms"));
app.get("/delivery", (req, res) => res.render("delivery"));

app.listen(3000, () => console.log("GardenRich running on http://localhost:3000"));