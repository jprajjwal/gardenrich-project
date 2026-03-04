require("dotenv").config();
const express = require("express");
const cookieSession = require("cookie-session");
const { createClient } = require("@supabase/supabase-js");
const app = express();
const path = require("path");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  cookieSession({
    name: "gardenrich_session",
    secret: process.env.SESSION_SECRET || "gardenrich-secret-key",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days — persists across Vercel instances
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
  })
);

// cookie-session doesn't have session.destroy() natively — polyfill it
app.use((req, res, next) => {
  if (!req.session.destroy) {
    req.session.destroy = (cb) => {
      req.session = null;
      if (cb) cb();
    };
  }
  next();
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseAnonKey;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Dedicated admin client for auth.admin calls (password reset, etc.)
// Requires SUPABASE_SERVICE_KEY — get from Supabase Dashboard → Project Settings → API → service_role
const supabaseAdmin = process.env.SUPABASE_SERVICE_KEY
  ? createClient(supabaseUrl, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

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
// Does 3 separate queries instead of relying on Supabase FK joins,
// which silently return null when foreign keys aren't registered.
async function enrichCartItems(rawCart) {
  if (!rawCart || rawCart.length === 0) return [];

  const productIds = [...new Set(rawCart.map((r) => parseInt(r.product_id, 10)))].filter(Boolean);

  // Fetch each product individually using .eq() — same pattern as the home page
  // .in() with an anon key can be blocked by RLS policies that only allow row-by-row reads
  const productResults = await Promise.all(
    productIds.map((pid) =>
      supabase.from("products").select("id, name, image, brand").eq("id", pid).maybeSingle()
    )
  );

  // Fetch each variant directly by its specific id (variant-aware cart)
  const variantIds = [...new Set(rawCart.map((r) => parseInt(r.variant_id, 10)))].filter(Boolean);
  const variantResults = await Promise.all(
    variantIds.map((vid) =>
      supabase
        .from("product_variants")
        .select("id, product_id, price, weight, mrp, stock")
        .eq("id", vid)
        .maybeSingle()
    )
  );

  // Log any errors so you can see what's failing in the terminal
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
    if (data) variantMap[parseInt(data.id, 10)] = data;
  });

  return rawCart.map((item) => {
    const pid = parseInt(item.product_id, 10);
    const vid = parseInt(item.variant_id, 10);
    const product = productMap[pid] || {};
    const variant = variantMap[vid] || {};
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
  // Prevent browser from caching the home page so stock levels are always fresh
  res.set("Cache-Control", "no-store");
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
        .select("product_id, variant_id, quantity")
        .eq("user_id", req.session.user.id);

      if (cartItems) {
        cartItems.forEach((item) => {
          // Key by variant_id so each variant tracks separately on the home page
          if (item.variant_id) cartMap[item.variant_id] = item.quantity;
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
app.get("/login", (req, res) => res.render("login", { error: null, email: "" }));

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const renderErr = (errorCode) =>
    res.render("login", { error: errorCode, email });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("invalid login") || msg.includes("invalid email or password") || msg.includes("email not confirmed")) {
      return renderErr("invalid_credentials");
    } else if (msg.includes("user not found")) {
      return renderErr("user_not_found");
    } else if (msg.includes("disabled") || msg.includes("banned")) {
      return renderErr("account_disabled");
    }
    return renderErr("unknown");
  }

  const user = data.user;

  const { data: profile } = await supabase
    .from("profiles")
    .select("name, role")
    .eq("id", user.id)
    .single();

  req.session.user = {
    id: user.id,
    email: user.email,
    name: profile?.name || "User",
    role: profile?.role || "USER",
  };

  res.redirect("/");
});

function isAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "ADMIN") {
    return res.status(403).send("Access Denied");
  }
  next();
}

// ── OTP helper ───────────────────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.get("/signup", (req, res) => res.render("signup", { error: null }));

app.post("/signup", async (req, res) => {
  const { name, email, password, mobile } = req.body;
  const renderErr = (msg) => res.render("signup", { error: msg });

  // Validate all fields
  if (!name?.trim() || !email?.trim() || !password?.trim() || !mobile?.trim()) {
    return renderErr("All fields are required.");
  }
  if (!/^[0-9]{10}$/.test(mobile.trim())) {
    return renderErr("Mobile number must be exactly 10 digits.");
  }

  // Check mobile uniqueness against profiles table
  const { data: existingMobile } = await supabase
    .from("profiles")
    .select("id")
    .eq("mobile", mobile.trim())
    .maybeSingle();

  if (existingMobile) {
    return renderErr("This mobile number is already registered.");
  }

  // Check email uniqueness by attempting signUp first.
  // Supabase silently accepts duplicate emails but returns user with empty identities[].
  // We use this to detect duplicates BEFORE sending any OTP.
  const { data: probeData, error: probeError } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { data: { _probe: true } }, // mark as probe attempt
  });

  if (probeError) {
    return renderErr("Signup failed: " + probeError.message);
  }

  // If identities array is empty, this email is already registered in Supabase Auth
  if (!probeData.user || probeData.user.identities?.length === 0) {
    return renderErr("This email is already registered. Please log in.");
  }

  // Email is fresh — but we need to delete this probe user before creating the real one
  // Store the user id to clean up after OTP verification if needed
  const probeUserId = probeData.user.id;

  // Generate OTP and store pending signup in session (expires in 10 min)
  const otp = generateOTP();
  req.session.pendingSignup = {
    name: name.trim(),
    email: email.trim(),
    password,
    mobile: mobile.trim(),
    otp,
    probeUserId, // auth user already created — just needs profile on verify
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    attempts: 0,
  };

  // Send OTP email
  try {
    await transporter.sendMail({
      from: `"GardenRich" <${process.env.EMAIL_USER}>`,
      to: email.trim(),
      subject: "Your GardenRich Verification Code",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:#16a34a;color:white;padding:24px;border-radius:16px 16px 0 0;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:900;">Garden<span style="color:#bbf7d0;">Rich</span></h1>
          </div>
          <div style="background:white;padding:32px;border:1px solid #f0f0f0;border-radius:0 0 16px 16px;text-align:center;">
            <p style="color:#52525b;font-size:15px;margin-bottom:8px;">Hi <strong>${name.trim()}</strong>, use this code to verify your account:</p>
            <div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#18181b;padding:24px 0;">${otp}</div>
            <p style="color:#a1a1aa;font-size:13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
            <p style="color:#a1a1aa;font-size:12px;margin-top:16px;">If you didn't request this, you can ignore this email.</p>
          </div>
        </div>`,
    });
  } catch (emailErr) {
    console.error("OTP email error:", emailErr.message);
    return renderErr("Failed to send verification email. Please try again.");
  }

  res.render("verify-otp", { email: email.trim(), error: null });
});

// ── OTP verification ──────────────────────────────────────────
app.post("/verify-otp", async (req, res) => {
  const { otp } = req.body;
  const pending = req.session.pendingSignup;

  const renderVerify = (err) =>
    res.render("verify-otp", { email: pending?.email || "", error: err });

  if (!pending) {
    return res.render("verify-otp", { email: "", error: "Session expired. Please sign up again." });
  }

  // Check expiry
  if (Date.now() > pending.expiresAt) {
    delete req.session.pendingSignup;
    return res.render("signup", { error: "OTP expired. Please sign up again." });
  }

  // Max 5 attempts
  pending.attempts += 1;
  if (pending.attempts > 5) {
    delete req.session.pendingSignup;
    return res.render("signup", { error: "Too many incorrect attempts. Please sign up again." });
  }

  if (otp.trim() !== pending.otp) {
    return renderVerify(`Incorrect code. ${5 - pending.attempts + 1} attempt${5 - pending.attempts + 1 === 1 ? "" : "s"} remaining.`);
  }

  // OTP correct — account was already created as a probe during signup validation.
  // We just need to insert the profile record using the stored userId.
  const { name, email, mobile, probeUserId } = pending;

  const { error: profileError } = await supabase.from("profiles").insert([
    { id: probeUserId, name, email, mobile },
  ]);

  if (profileError) {
    console.error("Profile Error:", profileError.message);
  }

  delete req.session.pendingSignup;

  req.session.user = {
    id: probeUserId,
    email,
    name,
    role: "USER",
  };

  res.redirect("/");
});

// Resend OTP
app.post("/resend-otp", async (req, res) => {
  const pending = req.session.pendingSignup;

  if (!pending) {
    return res.render("signup", { error: "Session expired. Please sign up again." });
  }

  // Refresh OTP and expiry
  const newOtp = generateOTP();
  pending.otp = newOtp;
  pending.expiresAt = Date.now() + 10 * 60 * 1000;
  pending.attempts = 0;

  try {
    await transporter.sendMail({
      from: `"GardenRich" <${process.env.EMAIL_USER}>`,
      to: pending.email,
      subject: "Your New GardenRich Verification Code",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:#16a34a;color:white;padding:24px;border-radius:16px 16px 0 0;text-align:center;">
            <h1 style="margin:0;font-size:24px;font-weight:900;">Garden<span style="color:#bbf7d0;">Rich</span></h1>
          </div>
          <div style="background:white;padding:32px;border:1px solid #f0f0f0;border-radius:0 0 16px 16px;text-align:center;">
            <p style="color:#52525b;font-size:15px;margin-bottom:8px;">Your new verification code:</p>
            <div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#18181b;padding:24px 0;">${newOtp}</div>
            <p style="color:#a1a1aa;font-size:13px;">This code expires in <strong>10 minutes</strong>.</p>
          </div>
        </div>`,
    });
  } catch (e) {
    return res.render("verify-otp", { email: pending.email, error: "Failed to resend. Please try again." });
  }

  res.render("verify-otp", { email: pending.email, error: null, resent: true });
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ── Forgot Password ───────────────────────────────────────────
app.get("/forgot-password", (req, res) =>
  res.render("forgot-password", { error: null, success: null })
);

app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  const renderErr = (msg) => res.render("forgot-password", { error: msg, success: null });

  if (!email?.trim()) return renderErr("Please enter your email address.");

  // Check if email exists in profiles
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", email.trim())
    .maybeSingle();

  // Always show success message even if email not found (security best practice)
  // But only send OTP if account actually exists
  if (profile) {
    const otp = generateOTP();
    req.session.passwordReset = {
      email: email.trim(),
      otp,
      expiresAt: Date.now() + 10 * 60 * 1000,
      attempts: 0,
    };

    try {
      await transporter.sendMail({
        from: `"GardenRich" <${process.env.EMAIL_USER}>`,
        to: email.trim(),
        subject: "Reset Your GardenRich Password",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
            <div style="background:#16a34a;color:white;padding:24px;border-radius:16px 16px 0 0;text-align:center;">
              <h1 style="margin:0;font-size:24px;font-weight:900;">Garden<span style="color:#bbf7d0;">Rich</span></h1>
            </div>
            <div style="background:white;padding:32px;border:1px solid #f0f0f0;border-radius:0 0 16px 16px;text-align:center;">
              <p style="color:#52525b;font-size:15px;margin-bottom:8px;">Use this code to reset your password:</p>
              <div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#18181b;padding:24px 0;">${otp}</div>
              <p style="color:#a1a1aa;font-size:13px;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
              <p style="color:#a1a1aa;font-size:12px;margin-top:16px;">If you didn't request this, you can safely ignore this email.</p>
            </div>
          </div>`,
      });
    } catch (e) {
      console.error("Password reset email error:", e.message);
      return renderErr("Failed to send reset email. Please try again.");
    }
  }

  res.render("forgot-password", {
    error: null,
    success: "If an account exists for that email, a reset code has been sent.",
  });
});

// ── Reset Password (OTP verify + new password) ────────────────
app.get("/reset-password", (req, res) => {
  if (!req.session.passwordReset) return res.redirect("/forgot-password");
  res.render("reset-password", {
    email: req.session.passwordReset.email,
    error: null,
  });
});

app.post("/reset-password", async (req, res) => {
  const { otp, password, confirmPassword } = req.body;
  const pending = req.session.passwordReset;

  const renderErr = (msg) =>
    res.render("reset-password", { email: pending?.email || "", error: msg });

  if (!pending) return res.redirect("/forgot-password");

  if (Date.now() > pending.expiresAt) {
    delete req.session.passwordReset;
    return res.render("forgot-password", {
      error: "Reset code expired. Please request a new one.",
      success: null,
    });
  }

  pending.attempts += 1;
  if (pending.attempts > 5) {
    delete req.session.passwordReset;
    return res.render("forgot-password", {
      error: "Too many incorrect attempts. Please request a new code.",
      success: null,
    });
  }

  if (otp.trim() !== pending.otp) {
    return renderErr(`Incorrect code. ${6 - pending.attempts} attempt${6 - pending.attempts === 1 ? "" : "s"} remaining.`);
  }

  if (!password || password.length < 6) {
    return renderErr("Password must be at least 6 characters.");
  }

  if (password !== confirmPassword) {
    return renderErr("Passwords do not match.");
  }

  // Look up user's auth ID from profiles
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", pending.email)
    .maybeSingle();

  if (!profile) {
    delete req.session.passwordReset;
    return res.redirect("/forgot-password");
  }

  // Requires supabaseAdmin (service role key).
  // If not configured, guide the user to set it up.
  if (!supabaseAdmin) {
    console.error("Password reset requires SUPABASE_SERVICE_KEY env variable.");
    return renderErr(
      "Password reset is not configured yet. Please contact support or set the SUPABASE_SERVICE_KEY."
    );
  }

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(profile.id, {
    password,
  });

  if (updateErr) {
    console.error("Password update error:", updateErr.message);
    return renderErr("Failed to update password. Please try again.");
  }

  delete req.session.passwordReset;

  res.render("login", {
    error: null,
    email: pending.email,
    success: "Password updated successfully! Please log in.",
  });
});

// ── Admin ─────────────────────────────────────────────────────
app.get("/admin", isAdmin, async (req, res) => {
  res.redirect("/admin/dashboard");
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

    // ── Update existing variants (price, mrp, stock) ─────────
    // JS sends variantUpdates as JSON string in FormData
    const rawVariantUpdates = req.body.variantUpdates;
    if (rawVariantUpdates) {
      let variantUpdates = [];
      try { variantUpdates = JSON.parse(rawVariantUpdates); } catch(e) {}

      await Promise.all(variantUpdates.map(async (v) => {
        const vid = parseInt(v.id, 10);
        if (!vid) return;
        const updateFields = {
          stock: parseInt(v.stock, 10) || 0,
          price: parseFloat(v.price) || 0,
        };
        if (v.mrp !== null && v.mrp !== "" && v.mrp !== undefined) {
          updateFields.mrp = parseFloat(v.mrp);
        } else {
          updateFields.mrp = null;
        }
        console.log(`Updating variant ${vid}:`, updateFields);
        const { error: vErr } = await (supabaseAdmin || supabase)
          .from("product_variants")
          .update(updateFields)
          .eq("id", vid);
        if (vErr) console.error(`Variant ${vid} update failed:`, vErr.message);
      }));
    }

    // ── Insert new variants ───────────────────────────────────
    const rawNewVariants = req.body.newVariants;
    if (rawNewVariants) {
      let newVariants = [];
      try { newVariants = JSON.parse(rawNewVariants); } catch(e) {}
      if (newVariants.length > 0) {
        const inserts = newVariants.map(v => ({
          product_id: productId,
          weight: v.weight,
          price: parseFloat(v.price) || 0,
          mrp: v.mrp ? parseFloat(v.mrp) : null,
          stock: parseInt(v.stock) || 0,
        }));
        const { error: insErr } = await (supabaseAdmin || supabase)
          .from("product_variants").insert(inserts);
        if (insErr) console.error("New variants insert failed:", insErr.message);
      }
    }

    // ── Delete removed variants ───────────────────────────────
    const rawDeleteVariants = req.body.deleteVariants;
    if (rawDeleteVariants) {
      let deleteIds = [];
      try { deleteIds = JSON.parse(rawDeleteVariants); } catch(e) {}
      if (deleteIds.length > 0) {
        const { error: delErr } = await (supabaseAdmin || supabase)
          .from("product_variants")
          .delete()
          .in("id", deleteIds.map(id => parseInt(id, 10)));
        if (delErr) console.error("Variant delete failed:", delErr.message);
      }
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
  // Use supabaseAdmin (service key) to bypass RLS on orders table
  const adminClient = supabaseAdmin || supabase;
  const { data: rawOrders, error: ordersError } = await adminClient
    .from("orders")
    .select("*, addresses(*)")
    .order("created_at", { ascending: false });

  if (ordersError) console.error("Orders fetch error:", ordersError.message);

  // Fetch order_items separately for each order
  const orders = await Promise.all(
    (rawOrders || []).map(async (order) => {
      const { data: items, error: itemsErr } = await adminClient
        .from("order_items")
        .select("*")
        .eq("order_id", order.id);
      if (itemsErr) console.error("Items fetch error for order", order.id, ":", itemsErr.message);
      return { ...order, order_items: items || [] };
    })
  );

  // Use IST date (UTC+5:30) — manually add 330 min offset (reliable across all Node envs)
  const IST_OFFSET = 330 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET);
  const today = nowIST.toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);

  const toISTDate  = (utcStr) => new Date(new Date(utcStr).getTime() + IST_OFFSET).toISOString().slice(0, 10);
  const toISTMonth = (utcStr) => toISTDate(utcStr).slice(0, 7);

  const todayOrders = orders.filter((o) => toISTDate(o.created_at) === today);
  const thisMonthOrders = orders.filter((o) => toISTMonth(o.created_at) === thisMonth).length;
  const thisMonthRevenue = orders
    .filter((o) => toISTMonth(o.created_at) === thisMonth)
    .reduce((acc, o) => acc + o.total, 0);

  const monthlyStats = {};
  orders.forEach((order) => {
    const month = toISTMonth(order.created_at);
    if (!monthlyStats[month]) monthlyStats[month] = { count: 0, total: 0 };
    monthlyStats[month].count += 1;
    monthlyStats[month].total += order.total;
  });

  res.render("admin-orders", {
    orders: orders,
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

// ── Admin: Shipping Settings ──────────────────────────────────
app.post("/admin/settings/shipping", isAdmin, async (req, res) => {
  const cost = parseFloat(req.body.shipping_cost);
  if (isNaN(cost) || cost < 0) {
    return res.status(400).json({ error: "Invalid shipping cost." });
  }

  // Upsert — insert if not exists, update if exists
  const { error } = await supabase
    .from("settings")
    .upsert({ key: "shipping_cost", value: cost.toString() }, { onConflict: "key" });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, shippingCost: cost });
});

app.get("/admin/settings", isAdmin, async (req, res) => {
  const { data: shippingSetting } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "shipping_cost")
    .maybeSingle();

  const shippingCost = shippingSetting ? parseFloat(shippingSetting.value) : 0;
  res.render("admin-settings", { shippingCost });
});

// ── Admin: Product Variants (for edit modal) ─────────────────
app.get("/admin/product-variants/:productId", isAdmin, async (req, res) => {
    try {
        const { data: variants, error } = await supabase
            .from("product_variants")
            .select("id, weight, price, mrp, stock")
            .eq("product_id", req.params.productId)
            .order("id", { ascending: true });
        if (error) throw error;
        res.json({ variants: variants || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin: Dashboard ─────────────────────────────────────────
app.get("/admin/dashboard", isAdmin, async (req, res) => {
    const { data: categories } = await supabase
        .from("categories")
        .select("*")
        .order("id", { ascending: true });

    const { data: settingsRows } = await supabase.from("settings").select("key, value");
    const settings = {};
    (settingsRows || []).forEach(s => { settings[s.key] = s.value; });

    res.render("admin-dashboard", { categories: categories || [], settings });
});

// ── Admin: Settings API ───────────────────────────────────────
app.get("/admin/settings/data", isAdmin, async (req, res) => {
    try {
        const { data: settings } = await supabase.from("settings").select("key, value");
        const map = {};
        (settings || []).forEach(s => { map[s.key] = s.value; });
        res.json({ settings: map });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/admin/settings/save", isAdmin, async (req, res) => {
    try {
        const {
            shipping_cost, free_shipping_above, minimum_order_value,
            discount_type, discount_value, discount_code,
            discount_min_order, discount_expiry,
        } = req.body;

        const upserts = [
            { key: "shipping_cost", value: String(parseFloat(shipping_cost) || 0) },
            { key: "free_shipping_above", value: String(parseFloat(free_shipping_above) || 0) },
            { key: "minimum_order_value", value: String(parseFloat(minimum_order_value) || 0) },
            { key: "discount_type", value: discount_type || "none" },
            { key: "discount_value", value: String(parseFloat(discount_value) || 0) },
            { key: "discount_code", value: (discount_code || "").trim().toUpperCase() },
            { key: "discount_min_order", value: String(parseFloat(discount_min_order) || 0) },
            { key: "discount_expiry", value: discount_expiry || "" },
        ];

        for (const row of upserts) {
            await supabase.from("settings").upsert(row, { onConflict: "key" });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin: Category counts ────────────────────────────────────
app.get("/admin/categories/counts", isAdmin, async (req, res) => {
    try {
        const { data: categories } = await supabase.from("categories").select("id, slug");
        const counts = {};
        for (const cat of categories || []) {
            const { count } = await supabase
                .from("products")
                .select("*", { count: "exact", head: true })
                .eq("category", cat.slug);
            counts[cat.id] = count || 0;
        }
        res.json({ counts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin: Add category ───────────────────────────────────────
app.post("/admin/categories/add", isAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: "Category name is required." });

        const slug = name.toLowerCase().trim()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-");

        const { data: existing } = await supabase
            .from("categories").select("id").eq("slug", slug).single();

        if (existing) return res.status(400).json({ error: `Category "${name}" already exists.` });

        const { data, error } = await supabase
            .from("categories")
            .insert([{ name: name.trim(), slug }])
            .select().single();

        if (error) throw error;
        res.json({ success: true, category: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin: Rename category ────────────────────────────────────
app.post("/admin/categories/rename/:id", isAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: "Name is required." });
        const { error } = await supabase
            .from("categories").update({ name: name.trim() }).eq("id", id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Admin: Delete category ────────────────────────────────────
app.delete("/admin/categories/:id", isAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { data: cat } = await supabase
            .from("categories").select("slug, name").eq("id", id).single();
        if (!cat) return res.status(404).json({ error: "Category not found." });
        if (cat.slug === "all") return res.status(400).json({ error: "Cannot delete 'All Products'." });
        await supabase.from("products").update({ category: "all" }).eq("category", cat.slug);
        const { error } = await supabase.from("categories").delete().eq("id", id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Apply discount code (cart + checkout) ────────────────────
app.post("/apply-discount", async (req, res) => {
    try {
        const { code, orderTotal } = req.body;
        const { data: settings } = await supabase.from("settings").select("key, value");
        const map = {};
        (settings || []).forEach(s => { map[s.key] = s.value; });

        const savedCode    = map["discount_code"] || "";
        const discountType = map["discount_type"] || "none";
        const discountValue = parseFloat(map["discount_value"] || 0);
        const minOrder     = parseFloat(map["discount_min_order"] || 0);
        const expiry       = map["discount_expiry"] || "";

        if (!savedCode || discountType === "none") {
            return res.status(400).json({ error: "No active discount available." });
        }
        if (code.trim().toUpperCase() !== savedCode) {
            return res.status(400).json({ error: "Invalid discount code." });
        }
        if (expiry && new Date(expiry) < new Date()) {
            return res.status(400).json({ error: "This discount code has expired." });
        }
        if (minOrder > 0 && orderTotal < minOrder) {
            return res.status(400).json({ error: `Minimum order of Rs. ${minOrder} required for this code.` });
        }

        let discountAmount = 0;
        if (discountType === "percentage") {
            discountAmount = Math.round((orderTotal * discountValue) / 100);
        } else if (discountType === "flat") {
            discountAmount = discountValue;
        }
        discountAmount = Math.min(discountAmount, orderTotal);

        res.json({ success: true, discountAmount, discountType, discountValue });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Cart ──────────────────────────────────────────────────────
app.get("/cart", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: rawCart } = await supabase
    .from("carts")
    .select("*")
    .eq("user_id", req.session.user.id);

  const enrichedCart = await enrichCartItems(rawCart || []);
  const subtotal = enrichedCart.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const cartCount = enrichedCart.reduce((acc, item) => acc + item.quantity, 0);

  // Fetch ALL settings in one query
  const { data: settingsRows } = await supabase.from("settings").select("key, value");
  const settingsMap = {};
  (settingsRows || []).forEach(s => { settingsMap[s.key] = s.value; });

  const baseShipping = parseFloat(settingsMap["shipping_cost"] || 0);
  const freeAbove    = parseFloat(settingsMap["free_shipping_above"] || 0);
  const minOrder     = parseFloat(settingsMap["minimum_order_value"] || 0);
  const shippingCost = (freeAbove > 0 && subtotal >= freeAbove) ? 0 : baseShipping;

  res.render("cart", {
    cartItems: enrichedCart,
    total: subtotal,
    cartCount,
    shippingCost,
    freeAbove,
    minOrder,
    // Discount hint — lets user know the active promo code
    discountCode:     settingsMap["discount_code"] || "",
    discountType:     settingsMap["discount_type"] || "none",
    discountValue:    parseFloat(settingsMap["discount_value"] || 0),
    discountMinOrder: parseFloat(settingsMap["discount_min_order"] || 0),
  });
});

app.post("/cart/add", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });

  const { productId, variantId } = req.body;

  if (!variantId) return res.status(400).json({ error: "Variant not specified" });

  // Fetch this specific variant's stock
  const { data: variant } = await supabase
    .from("product_variants")
    .select("id, stock, price")
    .eq("id", variantId)
    .single();

  if (!variant) return res.status(400).json({ error: "Variant not found" });

  const stock = variant.stock !== undefined ? variant.stock : 99;

  if (stock === 0) {
    return res.status(400).json({ error: "Out of stock", stock: 0 });
  }

  const { data: existing } = await supabase
    .from("carts")
    .select("*")
    .eq("user_id", req.session.user.id)
    .eq("variant_id", variantId)
    .maybeSingle();

  if (existing) {
    const newQty = Math.min(existing.quantity + 1, stock);
    await supabase.from("carts").update({ quantity: newQty }).eq("id", existing.id);
  } else {
    await supabase.from("carts").insert([{
      user_id: req.session.user.id,
      product_id: productId,
      variant_id: parseInt(variantId, 10),
      quantity: 1,
    }]);
  }

  const { data: allItems } = await supabase
    .from("carts").select("quantity").eq("user_id", req.session.user.id);

  const totalItems = allItems?.reduce((acc, i) => acc + i.quantity, 0) || 0;
  res.json({ success: true, totalItems, stock });
});


app.post("/cart/update", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });

  const { productId, variantId, quantity } = req.body;

  if (!variantId) return res.status(400).json({ error: "Variant not specified" });

  if (quantity <= 0) {
    await supabase
      .from("carts").delete()
      .eq("user_id", req.session.user.id)
      .eq("variant_id", variantId);
  } else {
    const { data: variant } = await supabase
      .from("product_variants").select("stock").eq("id", variantId).single();

    const stock = variant?.stock !== undefined ? variant.stock : 99;
    const safeQty = Math.min(quantity, stock);

    const { data: existing } = await supabase
      .from("carts").select("id")
      .eq("user_id", req.session.user.id)
      .eq("variant_id", variantId)
      .maybeSingle();

    if (existing) {
      await supabase.from("carts").update({ quantity: safeQty }).eq("id", existing.id);
    } else {
      await supabase.from("carts").insert([{
        user_id: req.session.user.id,
        product_id: productId,
        variant_id: parseInt(variantId, 10),
        quantity: safeQty,
      }]);
    }
  }

  const { data: allItems } = await supabase
    .from("carts").select("quantity").eq("user_id", req.session.user.id);

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
  const subtotal = cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0);

  const { data: settingsRows } = await supabase.from("settings").select("key, value");
  const settingsMap = {};
  (settingsRows || []).forEach(s => { settingsMap[s.key] = s.value; });

  const baseShipping = parseFloat(settingsMap["shipping_cost"] || 0);
  const freeAbove    = parseFloat(settingsMap["free_shipping_above"] || 0);
  const minOrder     = parseFloat(settingsMap["minimum_order_value"] || 0);
  const shippingCost = (freeAbove > 0 && subtotal >= freeAbove) ? 0 : baseShipping;

  // Validate pre-applied discount from cart URL params
  const preAppliedCode = ((req.query.applied_code || "")).toUpperCase();
  let preAppliedDiscount = 0;

  if (preAppliedCode) {
    const savedCode   = (settingsMap["discount_code"] || "").toUpperCase();
    const discType    = settingsMap["discount_type"] || "none";
    const discVal     = parseFloat(settingsMap["discount_value"] || 0);
    const discMin     = parseFloat(settingsMap["discount_min_order"] || 0);
    const discExp     = settingsMap["discount_expiry"] || "";

    if (
      preAppliedCode === savedCode &&
      discType !== "none" &&
      (!discExp || new Date(discExp) >= new Date()) &&
      (discMin === 0 || subtotal >= discMin)
    ) {
      preAppliedDiscount = discType === "percentage"
        ? Math.round((subtotal * discVal) / 100)
        : Math.min(discVal, subtotal);
    }
  }

  const finalTotal = Math.max(0, subtotal + shippingCost - preAppliedDiscount);

  res.render("checkout", {
    addresses: addresses || [],
    cartItems,
    subtotal,
    total: finalTotal,
    shippingCost,
    minOrder,
    settingsMap,
    preAppliedCode,
    preAppliedDiscount,
  });
});

app.post("/checkout", async (req, res) => {
  try {
    if (!req.session.user) return res.redirect("/login");

    const { data: rawCart } = await supabase
      .from("carts")
      .select("*")
      .eq("user_id", req.session.user.id);

    if (!rawCart || rawCart.length === 0) return res.redirect("/cart");

    const cartItems = await enrichCartItems(rawCart);

    // ── Stock validation ──────────────────────────────────────
    const stockErrors = cartItems.filter((item) => item.stock < item.quantity);
    if (stockErrors.length > 0) {
      const msgs = stockErrors.map((item) =>
        item.stock === 0
          ? `"${item.product_name}" is out of stock`
          : `"${item.product_name}" only has ${item.stock} left`
      ).join(", ");
      return res.status(400).send(`Stock issue: ${msgs}. Please update your cart.`);
    }

    // ── Load settings & recalculate totals server-side ────────
    const { data: settingsRows } = await supabase.from("settings").select("key, value");
    const settingsMap = {};
    (settingsRows || []).forEach(s => { settingsMap[s.key] = s.value; });

    const subtotal  = cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0);
    const minOrder  = parseFloat(settingsMap["minimum_order_value"] || 0);
    const baseShip  = parseFloat(settingsMap["shipping_cost"] || 0);
    const freeAbove = parseFloat(settingsMap["free_shipping_above"] || 0);
    const shipping  = (freeAbove > 0 && subtotal >= freeAbove) ? 0 : baseShip;

    // Minimum order guard (server-side — cannot be bypassed)
    if (minOrder > 0 && subtotal < minOrder) {
      return res.status(400).send(`Minimum order value is Rs. ${minOrder}. Your cart total is Rs. ${subtotal}.`);
    }

    // ── Validate & apply discount ─────────────────────────────
    let discountAmount = 0;
    const clientDiscount = parseFloat(req.body.discount_amount || 0);
    const discountType   = settingsMap["discount_type"] || "none";
    const discountCode   = settingsMap["discount_code"] || "";
    const discountValue  = parseFloat(settingsMap["discount_value"] || 0);
    const discountMin    = parseFloat(settingsMap["discount_min_order"] || 0);
    const discountExpiry = settingsMap["discount_expiry"] || "";

    if (clientDiscount > 0 && discountCode && discountType !== "none") {
      const notExpired = !discountExpiry || new Date(discountExpiry) >= new Date();
      const meetsMin   = discountMin === 0 || subtotal >= discountMin;
      if (notExpired && meetsMin) {
        if (discountType === "percentage") {
          discountAmount = Math.round((subtotal * discountValue) / 100);
        } else if (discountType === "flat") {
          discountAmount = discountValue;
        }
        discountAmount = Math.min(discountAmount, subtotal);
      }
    }

    const total = Math.max(0, subtotal + shipping - discountAmount);

    const {
      selected_address, first_name, last_name,
      address_phone, phone, address, city, pin_code, email,
    } = req.body;

    // ── Resolve address ───────────────────────────────────────
    let addressId;
    if (selected_address) {
      addressId = selected_address;
    } else {
      const { data: newAddr, error: addrError } = await supabase
        .from("addresses")
        .insert([{
          user_id: req.session.user.id,
          first_name, last_name,
          phone: address_phone || phone,
          address, city, pin_code,
        }])
        .select().single();
      if (addrError) throw addrError;
      addressId = newAddr.id;
    }

    const { data: addressData } = await supabase
      .from("addresses").select("*").eq("id", addressId).single();

    // ── Create order ──────────────────────────────────────────
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert([{
        user_id: req.session.user.id,
        address_id: addressId,
        email, phone,
        status: "pending",
        total,
      }])
      .select().single();

    if (orderError) throw orderError;

    const orderItems = cartItems.map((item) => ({
      order_id: order.id,
      product_name: item.product_name,
      product_image: item.product_image,
      quantity: item.quantity,
      price: item.price,
    }));

    const { error: itemsError } = await supabase.from("order_items").insert(orderItems);
    if (itemsError) {
      console.error("order_items insert failed:", itemsError.message);
      throw new Error("Failed to save order items: " + itemsError.message);
    }

    // ── Decrement stock ───────────────────────────────────────
    await Promise.all(
      cartItems.map(async (item) => {
        let variantId = item.variant_id;
        if (!variantId) {
          const { data: vLookup } = await supabase
            .from("product_variants").select("id, stock")
            .eq("product_id", parseInt(item.product_id, 10))
            .order("id", { ascending: true }).limit(1).maybeSingle();
          if (!vLookup) return;
          variantId = vLookup.id;
        }
        const { data: vData } = await supabase
          .from("product_variants").select("stock").eq("id", variantId).single();
        if (!vData) return;
        const newStock = Math.max(0, vData.stock - item.quantity);
        await supabase.rpc("update_variant_stock", {
          p_variant_id: variantId, p_new_stock: newStock,
        });
      })
    );

    await supabase.from("carts").delete().eq("user_id", req.session.user.id);

    // ── Email helpers ─────────────────────────────────────────
    const buildItemsTable = (showUnit) =>
      cartItems.map((item) => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #f0f0f0;">
            <img src="${item.product_image}" width="50" style="border-radius:8px;vertical-align:middle;margin-right:10px;">
            ${item.product_name}
          </td>
          <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.weight}</td>
          <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.quantity}</td>
          ${showUnit ? `<td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:right;">Rs. ${item.price.toLocaleString("en-IN")}</td>` : ""}
          <td style="padding:10px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:bold;">
            Rs. ${(item.price * item.quantity).toLocaleString("en-IN")}
          </td>
        </tr>`).join("");

    const tableHeader = (showUnit) => `
      <thead>
        <tr style="background:#f4f4f5;">
          <th style="padding:10px;text-align:left;font-size:12px;text-transform:uppercase;">Product</th>
          <th style="padding:10px;text-align:center;font-size:12px;text-transform:uppercase;">Size</th>
          <th style="padding:10px;text-align:center;font-size:12px;text-transform:uppercase;">Qty</th>
          ${showUnit ? '<th style="padding:10px;text-align:right;font-size:12px;text-transform:uppercase;">Unit Price</th>' : ""}
          <th style="padding:10px;text-align:right;font-size:12px;text-transform:uppercase;">Total</th>
        </tr>
      </thead>`;

    const orderBreakdown = `
      <p style="margin:4px 0;">Subtotal: Rs. ${subtotal.toLocaleString("en-IN")}</p>
      ${discountAmount > 0 ? `<p style="margin:4px 0;color:#16a34a;">Discount: -Rs. ${discountAmount.toLocaleString("en-IN")}</p>` : ""}
      <p style="margin:4px 0;">Shipping: ${shipping === 0 ? "FREE" : "Rs. " + shipping.toLocaleString("en-IN")}</p>`;

    await transporter.sendMail({
      from: `"GardenRich Orders" <${process.env.EMAIL_USER}>`,
      to: process.env.ADMIN_EMAIL || "sahilcingh@gmail.com",
      cc: process.env.EMAIL_USER,
      subject: `🛒 New Order #${order.id.toString().slice(0, 8)} — Rs. ${total.toLocaleString("en-IN")}`,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:0 auto;">
          <h2 style="background:#18181b;color:white;padding:20px;border-radius:12px 12px 0 0;margin:0;">New Order Received</h2>
          <div style="background:white;padding:20px;border:1px solid #f0f0f0;border-radius:0 0 12px 12px;">
            <p><strong>Customer:</strong> ${addressData.first_name} ${addressData.last_name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Phone:</strong> ${phone}</p>
            <p><strong>Address:</strong> ${addressData.address}, ${addressData.city} — ${addressData.pin_code}</p>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:16px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${tableHeader(true)}<tbody>${buildItemsTable(true)}</tbody>
            </table>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:16px 0;">
            <div style="text-align:right;">
              ${orderBreakdown}
              <p style="font-size:20px;font-weight:900;color:#16a34a;margin-top:8px;">Total: Rs. ${total.toLocaleString("en-IN")}</p>
              <p style="color:#888;font-size:12px;">Payment: Cash On Delivery</p>
            </div>
          </div>
        </div>`,
    });

    await transporter.sendMail({
      from: `"GardenRich" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `✅ Order Confirmed — Rs. ${total.toLocaleString("en-IN")}`,
      html: `
        <div style="font-family:sans-serif;max-width:620px;margin:0 auto;">
          <h2 style="background:#16a34a;color:white;padding:20px;border-radius:12px 12px 0 0;margin:0;">Order Confirmed! 🎉</h2>
          <div style="background:white;padding:20px;border:1px solid #f0f0f0;border-radius:0 0 12px 12px;">
            <p>Hi <strong>${addressData.first_name}</strong>, your order has been placed!</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              ${tableHeader(false)}<tbody>${buildItemsTable(false)}</tbody>
            </table>
            <hr style="border:none;border-top:1px solid #f0f0f0;margin:16px 0;">
            <div style="text-align:right;">
              ${orderBreakdown}
              <p style="font-size:18px;font-weight:900;color:#16a34a;margin-top:8px;">Total: Rs. ${total.toLocaleString("en-IN")}</p>
            </div>
            <p style="background:#f4f4f5;padding:12px;border-radius:8px;">
              <strong>Delivering to:</strong><br>
              ${addressData.address}, ${addressData.city} — ${addressData.pin_code}<br>
              ${addressData.phone}
            </p>
            <p style="color:#888;font-size:12px;text-align:center;margin-top:16px;">Payment: Cash On Delivery</p>
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
// FIX: was reading req.query.id but redirect sends orderId
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
app.get("/delivery", async (req, res) => {
    const { data: settingsRows } = await supabase.from("settings").select("key, value");
    const settings = {};
    (settingsRows || []).forEach(s => { settings[s.key] = s.value; });
    res.render("delivery", { settings });
});

// ── Admin: Notifications (new orders since timestamp) ────────
app.get("/admin/notifications", isAdmin, async (req, res) => {
  try {
    const since = req.query.since
      ? new Date(req.query.since).toISOString()
      : new Date(Date.now() - 60 * 1000).toISOString(); // fallback: last 60s

    const adminClient = supabaseAdmin || supabase;
    const { data: newOrders, error } = await adminClient
      .from("orders")
      .select("id, total, created_at, email, status")
      .gt("created_at", since)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ orders: newOrders || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local dev: listen on port 3000
// Vercel: export the app as a serverless function
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(3000, () => console.log("GardenRich running on http://localhost:3000"));
}