const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// ENV
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// DB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.log(err));

// MODEL
const User = mongoose.model("User", {
  email: String,
  password: String,
  role: String, // 🔥 NEW
  bio: String,
  avatar: String,
});

// ROOT
app.get("/", (req, res) => {
  res.send("Backend is live");
});

// REGISTER
app.post("/register", async (req, res) => {
  const { email, password, role } = req.body;

  const existing = await User.findOne({ email });
  if (existing) return res.status(400).send("User exists");

  const hashed = await bcrypt.hash(password, 10);

  await new User({
    email,
    password: hashed,
    role: role || "viewer",
    bio: "",
    avatar: "",
  }).save();

  res.send("Registered");
});

// LOGIN
app.post("/login", async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) return res.status(401).send("Invalid login");

  const match = await bcrypt.compare(req.body.password, user.password);
  if (!match) return res.status(401).send("Invalid login");

  const token = jwt.sign({ email: user.email }, JWT_SECRET);

  res.json({
    token,
    role: user.role, // 🔥 RETURN ROLE
    email: user.email,
    bio: user.bio,
    avatar: user.avatar
  });
});

// START
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running"));