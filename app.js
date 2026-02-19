const express = require("express");
const session = require("express-session");
const { createClient } = require("@supabase/supabase-js");
const app = express();
const path = require("path");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() }); // Store file in memory briefly
const nodemailer = require("nodemailer");
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "prajjwalj02@gmail.com", // your gmail
    pass: "iwxedcnijtuvtuzr", // Gmail app password (not your real password)
  },
});

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
      query: searchQuery || "",
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

app.post(
  "/admin/add-product",
  isAdmin,
  upload.single("imageFile"),
  async (req, res) => {
    try {
      const { name, weightValue, unit, price } = req.body;
      const file = req.file;

      if (!file) return res.status(400).send("Please upload an image.");

      // 1. Create a unique filename
      const fileName = `${Date.now()}-${file.originalname}`;

      // 2. Upload to Supabase Storage Bucket
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from("product-images") // Must match your bucket name in Supabase
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      // 3. Get the Public URL of the uploaded file
      const { data: urlData } = supabase.storage
        .from("product-images")
        .getPublicUrl(fileName);

      const publicImageUrl = urlData.publicUrl;

      // 4. Insert into 'products' table using the Public URL
      const weight = `${weightValue} ${unit}`;
      const { error: dbError } = await supabase.from("products").insert([
        {
          name,
          weight,
          price: parseFloat(price),
          image: publicImageUrl, // This is the full https:// link
        },
      ]);

      if (dbError) throw dbError;

      res.redirect("/");
    } catch (err) {
      console.error("Upload Error:", err.message);
      res.status(500).send("Failed to add product: " + err.message);
    }
  },
);

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

// POST Update Profile
app.post("/profile/update", async (req, res) => {
  if (!req.session.user) return res.status(401).send("Unauthorized");

  const { name, mobile } = req.body;

  const { error } = await supabase
    .from("profiles")
    .update({ name, mobile })
    .eq("id", req.session.user.id);

  if (error) {
    return res.status(500).send("Update failed: " + error.message);
  }

  // Update the session name so the header reflects the change immediately
  req.session.user.name = name;

  res.redirect("/profile");
});

app.delete("/admin/delete-product/:id", isAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const { imageUrl } = req.body;

    // 1. Delete from Database
    const { error: dbError } = await supabase
      .from("products")
      .delete()
      .eq("id", productId);

    if (dbError) throw dbError;

    // 2. Delete from Storage (if it's a Supabase URL)
    if (imageUrl && imageUrl.includes("supabase.co")) {
      // Extract the filename from the URL
      const fileName = imageUrl.split("/").pop();

      await supabase.storage.from("product-images").remove([fileName]);
    }

    res.status(200).json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Delete Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/checkout", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const { data: cartItems } = await supabase
    .from("carts")
    .select(`quantity, products (*)`)
    .eq("user_id", req.session.user.id);

  const formattedItems =
    cartItems?.map((item) => ({
      quantity: item.quantity,
      productId: item.products,
    })) || [];

  const { data: addresses } = await supabase
    .from("addresses")
    .select("*")
    .eq("user_id", req.session.user.id)
    .order("created_at", { ascending: false });

  res.render("checkout", {
    cart: { items: formattedItems },
    addresses: addresses || [],
  });
});

app.post("/checkout", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  const userId = req.session.user.id;
  const {
    first_name,
    last_name,
    address,
    city,
    pin_code,
    selected_address,
    email,
    phone,
  } = req.body;

  try {
    // 1. Resolve address
    let addressId = selected_address;
    let addressDetails;

    if (!selected_address && first_name) {
      const { data: newAddr } = await supabase
        .from("addresses")
        .insert([
          {
            user_id: userId,
            first_name,
            last_name,
            phone,
            address,
            city,
            pin_code,
          },
        ])
        .select()
        .single();
      addressId = newAddr.id;
      addressDetails = newAddr;
    } else {
      const { data, error } = await supabase
        .from("addresses")
        .select("*")
        .eq("id", selected_address)
        .single();

      if (error || !data) {
        console.error("Address fetch error:", error);
        return res
          .status(400)
          .send("Could not find selected address. Please try again.");
      }

      addressDetails = data;
      addressId = data.id;
    }

    // 2. Fetch cart items
    const { data: cartItems } = await supabase
      .from("carts")
      .select("quantity, products (*)")
      .eq("user_id", userId);

    const total = cartItems.reduce(
      (acc, item) => acc + item.products.price * item.quantity,
      0,
    );

    // 3. Create order
    const { data: order } = await supabase
      .from("orders")
      .insert([
        {
          user_id: userId,
          address_id: addressId,
          email,
          phone,
          total,
          status: "pending",
        },
      ])
      .select()
      .single();

    // 4. Save order items
    const orderItems = cartItems.map((item) => ({
      order_id: order.id,
      product_id: item.products.id,
      product_name: item.products.name,
      product_image: item.products.image,
      quantity: item.quantity,
      price: item.products.price,
    }));

    await supabase.from("order_items").insert(orderItems);

    // 5. Clear cart
    await supabase.from("carts").delete().eq("user_id", userId);

    // 6. Send email to admin
    const itemRows = cartItems
      .map(
        (item) =>
          `<tr>
                <td style="padding:8px;border-bottom:1px solid #eee;">${item.products.name}</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">${item.quantity}</td>
                <td style="padding:8px;border-bottom:1px solid #eee;">Rs. ${item.products.price * item.quantity}</td>
            </tr>`,
      )
      .join("");

    await transporter.sendMail({
      from: "prajjwalj02@gmail.com",
      to: "sahilcing@gmail.com", // admin email
      subject: `🛒 New Order from ${addressDetails.first_name} ${addressDetails.last_name}`,
      html: `
                <div style="font-family:sans-serif;max-width:600px;margin:auto;">
                    <h2 style="color:#16a34a;">New Order Received!</h2>
                    <p><strong>Order ID:</strong> ${order.id}</p>
                    <p><strong>Customer:</strong> ${addressDetails.first_name} ${addressDetails.last_name}</p>
                    <p><strong>Phone:</strong> ${addressDetails.phone}</p>
                    <p><strong>Email:</strong> ${email}</p>
                    <p><strong>Address:</strong> ${addressDetails.address}, ${addressDetails.city} - ${addressDetails.pin_code}</p>
                    <p><strong>Payment:</strong> Cash On Delivery</p>

                    <h3 style="margin-top:24px;">Items Ordered</h3>
                    <table style="width:100%;border-collapse:collapse;">
                        <thead>
                            <tr style="background:#f4f4f4;">
                                <th style="padding:8px;text-align:left;">Product</th>
                                <th style="padding:8px;text-align:left;">Qty</th>
                                <th style="padding:8px;text-align:left;">Price</th>
                            </tr>
                        </thead>
                        <tbody>${itemRows}</tbody>
                    </table>

                    <h3 style="margin-top:16px;color:#16a34a;">Total: Rs. ${total}</h3>
                </div>
            `,
    });

    // 7. Redirect to success page
    res.redirect(`/order-success?id=${order.id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong. Please try again.");
  }
});

app.get("/order-success", async (req, res) => {
  const { id } = req.query;

  const { data: order } = await supabase
    .from("orders")
    .select("*, addresses(*), order_items(*)")
    .eq("id", id)
    .single();

  res.render("order-success", { order });
});

app.get("/privacy", (req, res) => {
  res.render("privacy");
});

app.get("/returns", (req, res) => {
  res.render("refund");
});

app.get("/terms", (req, res) => {
  res.render("terms");
});

app.get("/delivery", (req, res) => {
  res.render("delivery");
});

app.listen(3000);
