const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();

// 🔑 CONFIG
const stripe = Stripe("sk_test_51TRswyS0KB9oyDfgsKwX66Soytt0gYDXBvVfUuEtwGafMC12GJF7dKjmbNzyhvhlngmwmU51LVVPIERpo7XhTjAx00qPDGsGnf");
const JWT_SECRET = "supersecretkey";
const endpointSecret = "sk_test_51TRswyS0KB9oyDfgsKwX66Soytt0gYDXBvVfUuEtwGafMC12GJF7dKjmbNzyhvhlngmwmU51LVVPIERpo7XhTjAx00qPDGsGnf";

// ⚠️ RAW body ONLY for webhook
app.post("/webhook", express.raw({ type: "application/json" }));

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// -------- DATABASE --------
mongoose.connect("mongodb://127.0.0.1:27017/feetapp")
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// -------- MODELS --------
const User = mongoose.model("User", {
  email: String,
  password: String,
  bio: String,
  avatar: String,
  stripeAccountId: String,
  subscriptions: [String] // creator emails
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

  if (!user) return res.status(404).send("User not found");

  if (req.body.bio) user.bio = req.body.bio;

  if (req.file) {
    user.avatar = `http://localhost:5000/uploads/${req.file.filename}`;
  }

  await user.save();
  res.json(user);
});

// -------- UPLOAD IMAGE --------
app.post("/upload", auth, upload.single("image"), async (req, res) => {
  const url = `http://localhost:5000/uploads/${req.file.filename}`;

  await new Image({
    url,
    owner: req.user.email
  }).save();

  res.json({ url });
});

// -------- CONNECT STRIPE (CREATOR ONBOARDING) --------
app.post("/connect-account", auth, async (req, res) => {
  const account = await stripe.accounts.create({
    type: "express"
  });

  const user = await User.findOne({ email: req.user.email });
  user.stripeAccountId = account.id;
  await user.save();

  const accountLink = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: "http://localhost:3000",
    return_url: "http://localhost:3000",
    type: "account_onboarding"
  });

  res.json({ url: accountLink.url });
});

// -------- CREATE SUBSCRIPTION --------
app.post("/create-subscription", auth, async (req, res) => {
  const { creatorEmail } = req.body;

  const creator = await User.findOne({ email: creatorEmail });
  if (!creator || !creator.stripeAccountId) {
    return res.status(400).send("Creator not set up");
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "subscription",
    line_items: [
      {
        price_data: {
          currency: "gbp",
          product_data: {
            name: `Subscription to ${creatorEmail}`
          },
          unit_amount: 500,
          recurring: { interval: "month" }
        },
        quantity: 1
      }
    ],
    payment_intent_data: {
      application_fee_amount: 100, // your fee (£1)
      transfer_data: {
        destination: creator.stripeAccountId
      }
    },
    metadata: {
      email: req.user.email,
      creator: creatorEmail
    },
    success_url: `http://localhost:3000/creator/${creatorEmail}?success=true`,
    cancel_url: `http://localhost:3000/creator/${creatorEmail}`
  });

  res.json({ url: session.url });
});

// -------- WEBHOOK (SECURE PAYMENT CONFIRMATION) --------
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      endpointSecret
    );
  } catch (err) {
    console.log("Webhook error:", err.message);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const email = session.metadata.email;
    const creator = session.metadata.creator;

    const user = await User.findOne({ email });

    if (user && !user.subscriptions.includes(creator)) {
      user.subscriptions.push(creator);
      await user.save();
      console.log("Subscription saved:", email, "->", creator);
    }
  }

  res.sendStatus(200);
});

// -------- CREATOR PROFILE --------
app.get("/creator/:email", auth, async (req, res) => {
  const creator = await User.findOne({ email: req.params.email });
  const viewer = await User.findOne({ email: req.user.email });

  const isSubscribed = viewer.subscriptions.includes(req.params.email);

  const images = isSubscribed
    ? await Image.find({ owner: req.params.email })
    : [];

  res.json({
    email: creator.email,
    bio: creator.bio,
    avatar: creator.avatar,
    images,
    isSubscribed
  });
});

// -------- EARNINGS DASHBOARD --------
app.get("/earnings", auth, async (req, res) => {
  const user = await User.findOne({ email: req.user.email });

  if (!user.stripeAccountId) {
    return res.json({ error: "Not connected to Stripe" });
  }

  try {
    const balance = await stripe.balance.retrieve({
      stripeAccount: user.stripeAccountId
    });

    const charges = await stripe.charges.list({
      limit: 10
    });

    res.json({
      available: balance.available[0]?.amount || 0,
      pending: balance.pending[0]?.amount || 0,
      recent: charges.data.map(c => ({
        amount: c.amount,
        created: c.created
      }))
    });

  } catch (err) {
    res.status(500).send("Stripe error");
  }
});

// -------- START SERVER --------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});