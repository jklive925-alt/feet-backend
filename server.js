const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();

// ✅ ENV VARIABLES (SET THESE IN RENDER)
const stripe = Stripe(process.env.STRIPE_SECRET);
const JWT_SECRET = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL;

// MIDDLEWARE
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// -------- DATABASE (FIXED FOR RENDER) --------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// -------- ROOT FIX --------
app.get("/", (req, res) => {
  res.send("Backend is live");
});

// -------- MODELS --------
const User = mongoose.model("User", {
  email: String,
  password: String,
  bio: String,
  avatar: String,
  stripeAccountId: String,
  subscriptions: [String]
});

const Image = mongoose.model("Image", {
  url: String,
  owner: String
});

// -------- AUTH --------
const auth = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send("No token");

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).send("Invalid token");
  }
};

// -------- REGISTER --------
app.post("/register", async (req, res) => {
  const { email, password } = req.body;

  const existing = await User.findOne({ email });
  if (existing) return res.status(400).send("User exists");

  const hashed = await bcrypt.hash(password, 10);

  await new User({
    email,
    password: hashed,
    bio: "",
    avatar: "",
    subscriptions: []
  }).save();

  res.send("Registered");
});

// -------- LOGIN --------
app.post("/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) return res.status(401).send("Invalid login");

  const match = await bcrypt.compare(req.body.password, user.password);
  if (!match) return res.status(401).send("Invalid login");

  const token = jwt.sign({ email: user.email }, JWT_SECRET);

  res.json({
    token,
    bio: user.bio,
    avatar: user.avatar,
    subscriptions: user.subscriptions
  });
});

// -------- FILE UPLOAD --------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// -------- UPDATE PROFILE --------
app.post("/update-profile", auth, upload.single("avatar"), async (req, res) => {
  const user = await User.findOne({ email: req.user.email });

  if (req.body.bio) user.bio = req.body.bio;

  if (req.file) {
    user.avatar = `${BASE_URL}/uploads/${req.file.filename}`;
  }

  await user.save();
  res.json(user);
});

// -------- UPLOAD IMAGE --------
app.post("/upload", auth, upload.single("image"), async (req, res) => {
  const url = `${BASE_URL}/uploads/${req.file.filename}`;

  await new Image({
    url,
    owner: req.user.email
  }).save();

  res.json({ url });
});

// -------- CONNECT STRIPE --------
app.post("/connect-account", auth, async (req, res) => {
  const account = await stripe.accounts.create({ type: "express" });

  const user = await User.findOne({ email: req.user.email });
  user.stripeAccountId = account.id;
  await user.save();

  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: BASE_URL,
    return_url: BASE_URL,
    type: "account_onboarding"
  });

  res.json({ url: accountLink.url });
});

// -------- SUBSCRIPTION --------
app.post("/create-subscription", auth, async (req, res) => {
  const { creatorEmail } = req.body;

  const creator = await User.findOne({ email: creatorEmail });
  if (!creator || !creator.stripeAccountId) {
    return res.status(400).send("Creator not set up");
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    line_items: [{
      price_data: {
        currency: "gbp",
        product_data: { name: `Subscription to ${creatorEmail}` },
        unit_amount: 500,
        recurring: { interval: "month" }
      },
      quantity: 1
    }],
    success_url: `${BASE_URL}?success=true`,
    cancel_url: BASE_URL
  });

  res.json({ url: session.url });
});

// -------- START SERVER --------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});