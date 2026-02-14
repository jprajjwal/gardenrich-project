const express = require("express");
const session = require("express-session");
const { createClient } = require("@supabase/supabase-js");
const app = express();
const path = require("path");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "gardenrich-secret-key", // Use a random string
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  }),
);

const supabaseUrl = "https://cqdtrsmoqeszhdmippzx.supabase.co";
const supabaseKey = "sb_publishable_oCt8OHvgiR72BjjsIOkjbw_R386qFfY";
const supabase = createClient(supabaseUrl, supabaseKey);

app.set("view engine", "ejs");

// Now req.session exists, so this won't crash!
app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;

  let totalItems = 0;
  if (req.session.user) {
    // Query the 'carts' table for all items belonging to this user
    const { data, error } = await supabase
      .from("carts")
      .select("quantity")
      .eq("user_id", req.session.user.id);

    // Sum up the quantities
    if (data) {
      totalItems = data.reduce((acc, item) => acc + item.quantity, 0);
    }
  }

  // This variable 'cartCount' can now be used in any .ejs file
  res.locals.cartCount = totalItems;
  next();
});

app.get("/", async (req, res) => {
  try {
    const searchQuery = req.query.search;

    // Start building the query
    let queryBuilder = supabase.from("products").select("*");

    // If a search term exists, filter the results
    if (searchQuery) {
      // .ilike('column', '%value%') handles case-insensitive search
      queryBuilder = queryBuilder.ilike("name", `%${searchQuery}%`);
    }

    const { data: products, error } = await queryBuilder;

    if (error) throw error;

    res.render("index", {
      products,
      query: searchQuery || ""
       // assuming you pass user for the header
    });
  } catch (err) {
    console.error("Search Error:", err.message);
    res.status(500).send("Error fetching products");
  }
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return res.send("Login failed: " + error.message);
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

app.get("/signup", (req, res) => {
  res.render("signup");
});

app.post("/signup", async (req, res) => {
  const { name, email, password, mobile } = req.body;

  // 1️⃣ Create auth user
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    console.error("Signup Error:", error.message);
    return res.send("Signup failed: " + error.message);
  }

  const user = data.user;

  // 2️⃣ Store extra details in profiles table
  const { error: profileError } = await supabase.from("profiles").insert([
    {
      id: user.id,
      name,
      email,
      mobile,
    },
  ]);

  if (profileError) {
    console.error("Profile Error:", profileError.message);
  }

  // 3️⃣ Save session
  req.session.user = user;

  res.redirect("/");
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

app.get("/admin", isAdmin, (req, res) => {
  res.render("admin");
});

app.post("/admin/add-product", isAdmin, async (req, res) => {
  const { name, weight, price, image } = req.body;

  await supabase.from("products").insert([{ name, weight, price, image }]);

  res.redirect("/");
});

app.get("/cart", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: cartItems } = await supabase
    .from("carts")
    .select(
      `
            quantity,
            products (*)
        `,
    )
    .eq("user_id", req.session.user.id);

  const formattedItems =
    cartItems?.map((item) => ({
      quantity: item.quantity,
      productId: item.products,
    })) || [];

  // ✅ Calculate total items
  const totalItems = formattedItems.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );

  res.render("cart", {
    cart: { items: formattedItems },
    totalItems,
  });
});

app.post("/cart/add", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/login");

  const { productId } = req.body;

  const { data, error } = await supabase
    .from("carts")
    .insert([{ user_id: user.id, product_id: productId, quantity: 1 }]);

  res.redirect("/cart");
});

app.post("/cart/update", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ totalItems: 0 });

  const { productId, quantity } = req.body;

  if (quantity <= 0) {
    await supabase
      .from("carts")
      .delete()
      .eq("user_id", user.id)
      .eq("product_id", productId);
  } else {
    // Upsert ensures we don't get duplicate rows for the same product
    await supabase.from("carts").upsert(
      {
        user_id: user.id,
        product_id: productId,
        quantity: quantity,
      },
      { onConflict: "user_id, product_id" },
    );
  }

  // Get the total sum of all items in the cart
  const { data: cartData } = await supabase
    .from("carts")
    .select("quantity")
    .eq("user_id", user.id);

  const totalItems = cartData
    ? cartData.reduce((acc, item) => acc + item.quantity, 0)
    : 0;

  res.json({ totalItems });
});

app.listen(3000);
