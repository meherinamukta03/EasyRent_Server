import express from 'express';
import cors from 'cors'
import 'dotenv/config'
import Stripe from 'stripe';

import { MongoClient, ObjectId } from 'mongodb';

import { verifyToken } from './middleware/verifyToken.js';
import { verifyRenter } from './middleware/verifyRenter.js';
import { verifyOwner } from './middleware/verifyOwner.js';
import { verifyAdmin } from './middleware/verifyAdmin.js';


const app = express();
const port = process.env.PORT || 5000;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

// Stripe needs the exact raw body to verify signatures, so this route is
// registered before the global express.json() middleware. Other routes keep
// using the normal JSON parser below.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(express.json())
app.use(cors({
  origin: FRONTEND_URL,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}))

const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.nafjga5.mongodb.net/`);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}


const connectedClient=await connectToMongoDB()

const database=connectedClient.db('EasyRent')

const users=database.collection('user')
const equipments=database.collection('equipments')

const rentalsCollection = database.collection("rentals");
const favoritesCollection = database.collection("favorites");
const paymentsCollection = database.collection("payments");
const contactMessagesCollection = database.collection("contactMessages");

// Better Auth stores its sessions and accounts in the same database. The admin
// API needs these collections to revoke access when an account is removed and
// to resolve owner/customer names for the rental overview.
const sessionsCollection = database.collection("session");
const accountsCollection = database.collection("account");

const USER_ROLES = ["customer", "owner", "admin"];

/** Expected failures carry an HTTP status; everything else becomes a 500. */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function toISO(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

/** Reusable middleware chains for each role. */
const customerAuth = [verifyToken, verifyRenter];
const ownerAuth = [verifyToken, verifyOwner];
const adminAuth = [verifyToken, verifyAdmin];

/** The acting identity always comes from the verified JWT. */
function getActingAdminId(req) {
  return req.user?.id || "";
}

function sendApiError(res, error, fallback) {
  if (error instanceof ApiError) {
    return res.status(error.status).send({ message: error.message });
  }

  console.error(error);
  return res.status(500).send({ message: fallback });
}

const EQUIPMENT_EDITABLE_FIELDS = [
  "name",
  "description",
  "category",
  "location",
  "rentalPrice",
  "rentalType",
  "quantity",
  "condition",
  "brand",
  "model",
  "terms",
  "image",
];

/** Shared validation for both the owner and the admin equipment update. */
function buildEquipmentUpdates(body) {
  const updates = {};

  for (const field of EQUIPMENT_EDITABLE_FIELDS) {
    if (body?.[field] !== undefined && body[field] !== null) {
      updates[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new ApiError(400, "No editable fields were provided");
  }

  if (updates.rentalPrice !== undefined) {
    const price = Number(updates.rentalPrice);
    if (!Number.isFinite(price) || price < 1) {
      throw new ApiError(400, "Rental price must be a positive number");
    }
    updates.rentalPrice = price;
  }

  if (updates.quantity !== undefined) {
    const quantity = Number(updates.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new ApiError(400, "Quantity must be a positive whole number");
    }
    updates.quantity = quantity;
  }

  return updates;
}

/**
 * Booking transitions an administrator is allowed to perform. Everything else
 * stays with the existing workflow: payment is verified by Stripe, the owner
 * accepts/confirms, and the server syncs Active/Completed from the dates.
 */
const ADMIN_BOOKING_TRANSITIONS = {
  Pending: ["Cancelled", "Rejected"],
  Confirmed: ["Cancelled"],
  Active: ["Completed"],
};

// One favorite per equipment per customer.
favoritesCollection
  .createIndex({ customerEmail: 1, equipmentId: 1 }, { unique: true })
  .catch((error) => console.log("Favorites index:", error.message));

// One payment record per Stripe Checkout Session. Combined with the
// $setOnInsert upsert in the webhook, this prevents duplicate payments.
paymentsCollection
  .createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true })
  .catch((error) => console.log("Payments index:", error.message));

/**
 * Advances booking status based on the rental dates. Confirmed bookings
 * become Active when the start date arrives and Completed after the end date.
 * Cancelled, Rejected and Refunded bookings are never touched.
 */
async function syncRentalProgress() {
  const now = new Date().toISOString();

  await rentalsCollection.updateMany(
    { bookingStatus: "Confirmed", rentalStartDate: { $lte: now } },
    { $set: { bookingStatus: "Active", updatedAt: now } }
  );

  await rentalsCollection.updateMany(
    { bookingStatus: "Active", rentalEndDate: { $lte: now } },
    { $set: { bookingStatus: "Completed", updatedAt: now } }
  );
}

/** Writes payment details once and keeps the rental document in sync. */
async function recordPaidBooking(booking, session, currency, paidAt) {
  const paymentIntentId = session.payment_intent || "";

  const updated = await rentalsCollection.findOneAndUpdate(
    {
      _id: booking._id,
      paymentStatus: { $nin: ["Paid", "Refunded"] },
    },
    {
      $set: {
        paymentStatus: "Paid",
        stripePaymentIntentId: paymentIntentId,
        paidAt,
        updatedAt: paidAt,
      },
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    return false;
  }

  await paymentsCollection.updateOne(
    { stripeSessionId: session.id },
    {
      $setOnInsert: {
        bookingId: booking._id,
        customerId: booking.customerId || "",
        customerEmail: booking.customerEmail || "",
        equipmentId: (booking.equipmentIdString || booking.equipmentId || "").toString(),
        amount: booking.totalAmount,
        currency,
        paymentStatus: "Paid",
        stripeSessionId: session.id,
        stripePaymentIntentId: paymentIntentId,
        created: paidAt,
      },
    },
    { upsert: true }
  );

  return true;
}



app.get('/', (req, res) => {
  res.send('hello from the server');
});

// Legacy endpoint. It is not used by the frontend, but it used to return raw
// user documents. Keep the response shape while removing authentication data
// (password hashes, account and session references) from every response.
app.get('/users', ...adminAuth, async(req, res) => {
  try {
    const result = await users
      .find({}, { projection: SAFE_USER_PROJECTION })
      .toArray();

    res.send(result.map(toAdminUserDto));
  } catch (error) {
    return sendApiError(res, error, "Failed to load users");
  }
});














app.get('/public/recent-equipments', async (req, res) => {
  try {
    const result = await equipments
      .find({ status: "Approved" })
      .sort({ createdAt: -1 })
      .limit(4)
      .toArray();

    res.status(200).send(result);
  } catch (error) {
    console.error("Recently added equipment error:", error);

    res.status(500).send({
      message: "Failed to fetch recently added equipment",
    });
  }
}); 




//ower




app.post('/equipments', ...ownerAuth, async(req,res)=>{
  try {
    // Ownership is taken from the verified JWT, never from the request body.
    const owner = await users.findOne(
      { email: req.user.email },
      { projection: { name: 1 } }
    );
    const payload = { ...req.body };
    delete payload.ownerName;

    const job = {
      ...payload,
      ownerInfo: {
        name: String(owner?.name || ""),
        email: req.user.email,
      },
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    const result = await equipments.insertOne(job);
    res.status(201).send(result);
  } catch (error) {
    return sendApiError(res, error, "Failed to add equipment");
  }
})

function getQueryString(value) {
  if (Array.isArray(value)) {
    return String(value[0] ?? "").trim();
  }

  return typeof value === "string" ? value.trim() : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


app.get("/equipments", ...ownerAuth, async (req, res) => {
  // Ignore any ?email= supplied by the browser: the JWT is authoritative.
  const result = await equipments.find({
    "ownerInfo.email": req.user.email
  }).toArray();

  res.send(result);
});

app.get('/public/equipments', async (req, res) => {
  try {
    const query = {};

    // Only approved equipment
    query.status = {
      $regex: /^approved$/i
    };

    // Search by equipment name and location
    if (req.query.search) {
      query.$or = [
        {
          name: {
            $regex: req.query.search,
            $options: 'i'
          }
        },
        {
          location: {
            $regex: req.query.search,
            $options: 'i'
          }
        }
      ];
    }

   
    if (req.query.category) {
      query.category = req.query.category;
    }

    // Filter by rental type
    if (req.query.rentalType) {
      query.rentalType = req.query.rentalType;
    }

    // Filter by price range
    if (req.query.minPrice || req.query.maxPrice) {
      query.rentalPrice = {};

      if (req.query.minPrice) {
        query.rentalPrice.$gte = Number(req.query.minPrice);
      }

      if (req.query.maxPrice) {
        query.rentalPrice.$lte = Number(req.query.maxPrice);
      }
    }

    // Filter by availability
    if (req.query.availability === 'Available') {
      query.quantity = { $gt: 0 };
    }

    if (req.query.availability === 'Unavailable') {
      query.quantity = { $lte: 0 };
    }

    // Sorting
    let sortQuery = { _id: -1 };

    if (req.query.sort === 'recent') {
      // Newest listings first. createdAt is written when equipment is added;
      // _id keeps older documents that predate it in newest-first order.
      sortQuery = { createdAt: -1, _id: -1 };
    }
    else if (req.query.sort === 'price_asc') {
      sortQuery = { rentalPrice: 1 };
    }
    else if (req.query.sort === 'price_desc') {
      sortQuery = { rentalPrice: -1 };
    }

    // Optional result cap (e.g. the homepage featured section asks for 6).
    // Applying .limit() here keeps the cap in the MongoDB query itself instead
    // of fetching every approved item and trimming it on the client.
    // The cap protects the public endpoint from unbounded requests.
    const rawLimit = getQueryString(req.query.limit);
    const requestedLimit = Number(rawLimit);
    const limit =
      rawLimit && Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 50)
        : 0;

    const cursor = equipments.find(query);

    let resultQuery = cursor.sort(sortQuery);

    if (limit > 0) {
      resultQuery = resultQuery.limit(limit);
    }

    const result = await resultQuery.toArray();

    res.send(result);

  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: 'Failed to fetch equipment'
    });
  }
});


// Approved-equipment counts per stored category. The grouping and counting
// happen in MongoDB so the client never has to download the whole catalogue.
app.get('/public/categories', async (req, res) => {
  try {
    const result = await equipments
      .aggregate([
        { $match: { status: { $regex: /^approved$/i } } },
        {
          $group: {
            _id: '$category',
            count: { $sum: 1 }
          }
        },
        {
          $project: {
            _id: 0,
            category: { $ifNull: ['$_id', 'Other'] },
            count: 1
          }
        },
        { $sort: { count: -1, category: 1 } }
      ])
      .toArray();

    res.send(result);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: 'Failed to fetch equipment categories'
    });
  }
});

// Public contact form. Messages are stored in MongoDB and never expose
// database details to the caller.
app.post('/public/contact', async (req, res) => {
  try {
    const name = getString(req.body?.name);
    const email = getString(req.body?.email);
    const subject = getString(req.body?.subject);
    const message = getString(req.body?.message);

    if (name.length < 2 || name.length > 100) {
      return res.status(400).send({ message: 'Please enter your full name' });
    }

    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).send({ message: 'Please enter a valid email address' });
    }

    if (subject.length < 3 || subject.length > 200) {
      return res.status(400).send({ message: 'Please enter a subject' });
    }

    if (message.length < 10 || message.length > 2000) {
      return res.status(400).send({
        message: 'Please write a message of at least 10 characters'
      });
    }

    const document = {
      name,
      email,
      subject,
      message,
      status: 'New',
      createdAt: new Date().toISOString(),
    };

    const result = await contactMessagesCollection.insertOne(document);

    res.status(201).send({
      message: 'Your message has been sent successfully.',
      id: result.insertedId.toString(),
    });
  } catch (error) {
    console.error('Contact message error:', error);

    res.status(500).send({
      message: 'Failed to send your message. Please try again.'
    });
  }
});


app.patch('/equipments/:id', ...ownerAuth, async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid equipment ID"
      });
    }

    const updates = buildEquipmentUpdates(req.body);

    // The owner filter uses only the verified token identity.
    const result = await equipments.findOneAndUpdate(
      {
        _id: new ObjectId(id),
        "ownerInfo.email": req.user.email
      },
      {
        $set: updates
      },
      {
        returnDocument: "after"
      }
    );

    if (!result) {
      return res.status(404).send({
        message: "Equipment not found or you do not have permission to edit it"
      });
    }

    res.send({
      message: "Equipment updated successfully",
      equipment: result
    });

  } catch (error) {
    return sendApiError(res, error, "Failed to update equipment");
  }
});

app.delete('/equipments/:id', ...ownerAuth, async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid equipment ID"
      });
    }

    const query = {
      _id: new ObjectId(id),
      "ownerInfo.email": req.user.email
    };

    const result = await equipments.deleteOne(query);

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Equipment not found or you do not have permission to delete it"
      });
    }

    res.send({
      message: "Equipment deleted successfully",
      result
    });

  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to delete equipment"
    });
  }
});


app.get("/owner/rentals", ...ownerAuth, async (req, res) => {
  try {
    // The owner identity comes from the verified JWT, not from the query.
    const email = req.user.email;

    await syncRentalProgress();

   
    const ownerEquipments = await equipments.find({ "ownerInfo.email": email })
      .toArray();

    const equipmentIds = ownerEquipments.map(
      (equipment) => equipment._id
    );

   
    const rental = await rentalsCollection
      .find({
        equipmentId: { $in: equipmentIds },
      })
      .sort({ _id: -1 })
      .toArray();

    res.send(rental);
  } catch (error) {
    console.log(error);

    res.status(500).send({
      message: "Failed to fetch owner rentals",
    });
  }
});


// ---------------------------------------------------------------------------
// Customer favorites
// ---------------------------------------------------------------------------

function getString(value) {
  return typeof value === "string" ? value.trim() : "";
}

app.get("/favorites", ...customerAuth, async (req, res) => {
  try {
    const customerEmail = req.user.email;
    const equipmentId = getQueryString(req.query.equipmentId);
    const query = { customerEmail };

    if (equipmentId) query.equipmentId = equipmentId;

    const result = await favoritesCollection
      .find(query)
      .sort({ _id: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to fetch favorites" });
  }
});

app.post("/favorites", ...customerAuth, async (req, res) => {
  try {
    const customerEmail = req.user.email;
    const customerId = req.user.id;
    const equipmentId = getString(req.body?.equipmentId);
    const equipment = req.body?.equipment;

    if (!customerEmail || !equipmentId || !equipment || typeof equipment !== "object") {
      return res.status(400).send({ message: "Invalid favorite data" });
    }

    const existing = await favoritesCollection.findOne({ customerEmail, equipmentId });

    if (existing) {
      return res.send({ message: "Already in favorites", favorite: existing });
    }

    const favorite = {
      customerEmail,
      ...(customerId ? { customerId } : {}),
      equipmentId,
      equipment,
      createdAt: new Date().toISOString(),
    };

    const result = await favoritesCollection.insertOne(favorite);

    res.status(201).send({
      message: "Added to favorites",
      favorite: { ...favorite, _id: result.insertedId },
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.send({ message: "Already in favorites" });
    }

    console.log(error);
    res.status(500).send({ message: "Failed to add favorite" });
  }
});

app.delete("/favorites", ...customerAuth, async (req, res) => {
  try {
    const customerEmail = req.user.email;
    const equipmentId = getQueryString(req.query.equipmentId);

    if (!equipmentId) {
      return res.status(400).send({ message: "Invalid favorite data" });
    }

    const result = await favoritesCollection.deleteOne({ customerEmail, equipmentId });

    res.send({
      message: "Removed from favorites",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to remove favorite" });
  }
});

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

function calculateRental(equipment, start, end, quantity) {
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000));
  const rentalType = String(equipment.rentalType || "Daily").toLowerCase();

  let duration = days;
  if (rentalType === "weekly") duration = Math.max(1, Math.ceil(days / 7));
  if (rentalType === "monthly") duration = Math.max(1, Math.ceil(days / 30));

  return {
    rentalDuration: duration,
    rentalDays: days,
    totalAmount: Number(equipment.rentalPrice) * duration * quantity,
  };
}

// Stripe expects amounts in the smallest currency unit. These currencies are
// zero-decimal, so the amount is used as-is.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

function toStripeMinorUnits(amount, currency) {
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(String(currency).toLowerCase()) ? 1 : 100;
  return Math.round(Number(amount) * multiplier);
}

/**
 * When no webhook signing secret is configured, re-fetch the event object
 * from Stripe itself. The payload is only used for the event id/type; all
 * status, amount and currency values come from Stripe's API, so a forged
 * payload cannot mark a booking as paid.
 */
async function resolveStripeEventObject(payload) {
  const type = payload?.type;
  const objectId = payload?.data?.object?.id;

  if (!type || !objectId) return null;

  if (type === 'checkout.session.completed' || type === 'checkout.session.expired') {
    return await stripe.checkout.sessions.retrieve(objectId);
  }
  if (type === 'payment_intent.payment_failed') {
    return await stripe.paymentIntents.retrieve(objectId);
  }
  if (type === 'charge.refunded') {
    return await stripe.charges.retrieve(objectId);
  }

  return null;
}

/**
 * Verifies the webhook signature (or re-fetches from Stripe), matches the
 * session to a stored booking, confirms the paid amount/currency, marks the
 * booking paid, and records the transaction. Safe to call more than once.
 */
async function handleStripeWebhook(req, res) {
  if (!stripe) {
    return res.status(500).send({ message: 'Stripe is not configured' });
  }

  let event;
  const signature = req.headers['stripe-signature'];

  if (process.env.STRIPE_WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.log('Stripe webhook signature error:', error.message);
      return res.status(400).send({ message: 'Invalid webhook signature' });
    }
  } else {
    try {
      const payload = JSON.parse(req.body.toString());
      const verifiedObject = await resolveStripeEventObject(payload);

      if (!verifiedObject) {
        return res.send({ received: true });
      }

      event = { type: payload.type, data: { object: verifiedObject } };
    } catch (error) {
      console.error('Stripe webhook fallback verification failed:', error.message);
      return res.status(400).send({ message: 'Invalid webhook payload' });
    }
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      if (session.payment_status !== 'paid') {
        return res.send({ received: true });
      }

      const bookingId = session.metadata?.bookingId || session.client_reference_id;

      if (!bookingId || !ObjectId.isValid(bookingId)) {
        return res.status(400).send({ message: 'Invalid booking reference' });
      }

      const booking = await rentalsCollection.findOne({
        _id: new ObjectId(bookingId),
      });

      if (!booking) {
        return res.status(404).send({ message: 'Booking not found' });
      }

      if (booking.stripeSessionId !== session.id) {
        return res.status(400).send({ message: 'Checkout session mismatch' });
      }

      const expectedCurrency = booking.stripeCurrency || STRIPE_CURRENCY;
      const expectedAmount = toStripeMinorUnits(booking.totalAmount, expectedCurrency);

      if (
        session.currency !== expectedCurrency ||
        session.amount_total !== expectedAmount
      ) {
        return res.status(400).send({ message: 'Payment amount mismatch' });
      }

      const paidAt = new Date().toISOString();

      // Only payment status changes here. Booking status stays Pending until
      // the equipment owner explicitly accepts the booking.
      await recordPaidBooking(booking, session, expectedCurrency, paidAt);

      return res.send({ received: true });
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const bookingId = session.metadata?.bookingId || session.client_reference_id;

      if (bookingId && ObjectId.isValid(bookingId)) {
        await rentalsCollection.updateOne(
          {
            _id: new ObjectId(bookingId),
            stripeSessionId: session.id,
            paymentStatus: 'Pending',
          },
          { $set: { paymentStatus: 'Failed', updatedAt: new Date().toISOString() } }
        );
      }

      return res.send({ received: true });
    }

    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      const bookingId = paymentIntent.metadata?.bookingId;

      if (bookingId && ObjectId.isValid(bookingId)) {
        await rentalsCollection.updateOne(
          {
            _id: new ObjectId(bookingId),
            paymentStatus: 'Pending',
          },
          {
            $set: {
              paymentStatus: 'Failed',
              stripePaymentIntentId: paymentIntent.id || '',
              updatedAt: new Date().toISOString(),
            },
          }
        );
      }

      return res.send({ received: true });
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const paymentIntentId = charge.payment_intent;

      if (paymentIntentId) {
        const refundedAt = new Date().toISOString();

        await rentalsCollection.updateOne(
          {
            stripePaymentIntentId: paymentIntentId,
            paymentStatus: 'Paid',
          },
          { $set: { paymentStatus: 'Refunded', updatedAt: refundedAt } }
        );

        await paymentsCollection.updateOne(
          { stripePaymentIntentId: paymentIntentId },
          {
            $set: {
              paymentStatus: 'Refunded',
              refundedAt,
              amountRefunded: charge.amount_refunded || 0,
            },
          }
        );
      }

      return res.send({ received: true });
    }

    return res.send({ received: true });
  } catch (error) {
    console.error('Stripe webhook processing error:', error);

    return res.status(500).send({ message: 'Failed to process webhook' });
  }
}

function validateBookingInput(body) {
  const equipmentId = getString(body?.equipmentId);
  const customerEmail = getString(body?.customerEmail);
  const startValue = getString(body?.rentalStartDate);
  const endValue = getString(body?.rentalEndDate);
  const requiredQuantity = Number(body?.requiredQuantity);
  const contactNumber = getString(body?.contactNumber);
  const deliveryAddress = getString(body?.deliveryAddress);

  if (!ObjectId.isValid(equipmentId)) {
    throw new ApiError(400, "A valid equipment ID is required");
  }
  if (!customerEmail) {
    throw new ApiError(401, "You must be signed in to book equipment");
  }

  const start = new Date(startValue);
  const end = new Date(endValue);

  if (!startValue || Number.isNaN(start.getTime())) {
    throw new ApiError(400, "A valid rental start date is required");
  }
  if (!endValue || Number.isNaN(end.getTime())) {
    throw new ApiError(400, "A valid rental end date is required");
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(start);
  startDate.setHours(0, 0, 0, 0);

  if (startDate < today) {
    throw new ApiError(400, "Rental start date cannot be in the past");
  }
  if (end <= start) {
    throw new ApiError(400, "Rental end date must be after the start date");
  }
  if (!Number.isInteger(requiredQuantity) || requiredQuantity < 1) {
    throw new ApiError(400, "Required quantity must be a positive whole number");
  }
  if (!/^\d{7,15}$/.test(contactNumber.replace(/[\s-]/g, ""))) {
    throw new ApiError(400, "Enter a valid contact number");
  }
  if (deliveryAddress.length < 5) {
    throw new ApiError(400, "Enter a valid delivery address");
  }

  return {
    equipmentId,
    customerEmail,
    customerId: getString(body?.customerId),
    customerName: getString(body?.customerName),
    start,
    end,
    requiredQuantity,
    contactNumber,
    deliveryAddress,
    notes: getString(body?.notes),
  };
}

app.post("/bookings", ...customerAuth, async (req, res) => {
  const session = client.startSession();

  try {
    const customer = await users.findOne(
      { email: req.user.email },
      { projection: { name: 1 } }
    );

    // Identity fields are injected from the verified token, so a client cannot
    // create a booking on behalf of another customer.
    const input = validateBookingInput({
      ...req.body,
      customerEmail: req.user.email,
      customerId: req.user.id,
      customerName: customer?.name || "",
    });
    let booking = null;

    await session.withTransaction(
      async () => {
        const equipment = await equipments.findOne(
          { _id: new ObjectId(input.equipmentId) },
          { session }
        );

        if (!equipment || !/^approved$/i.test(String(equipment.status || ""))) {
          throw new ApiError(404, "Equipment not found");
        }

        const stock = Number(equipment.quantity || 0);

        if (stock < 1) {
          throw new ApiError(409, "This equipment is currently unavailable");
        }

        const startISO = input.start.toISOString();
        const endISO = input.end.toISOString();

        // Overlapping bookings still reserve stock for their whole period.
        const activeBookings = await rentalsCollection
          .find(
            {
              equipmentId: new ObjectId(input.equipmentId),
              bookingStatus: { $nin: ["Cancelled", "Rejected", "Completed"] },
              rentalStartDate: { $lte: endISO },
              rentalEndDate: { $gte: startISO },
            },
            { session }
          )
          .toArray();

        const reserved = activeBookings.reduce(
          (total, item) => total + Number(item.requiredQuantity || 0),
          0
        );

        if (reserved + input.requiredQuantity > stock) {
          throw new ApiError(
            409,
            `Only ${Math.max(0, stock - reserved)} unit(s) available for this period`
          );
        }

        const { rentalDuration, rentalDays, totalAmount } = calculateRental(
          equipment,
          input.start,
          input.end,
          input.requiredQuantity
        );

        const document = {
          equipmentId: new ObjectId(input.equipmentId),
          equipmentIdString: input.equipmentId,
          equipmentName: equipment.name,
          equipmentImage: equipment.image || "",
          customerEmail: input.customerEmail,
          customerId: input.customerId || undefined,
          customerName: input.customerName || undefined,
          ownerEmail: equipment.ownerInfo?.email || "",
          rentalStartDate: startISO,
          rentalEndDate: endISO,
          rentalDays,
          rentalDuration,
          rentalType: equipment.rentalType || "Daily",
          requiredQuantity: input.requiredQuantity,
          rentalPrice: Number(equipment.rentalPrice || 0),
          totalAmount,
          contactNumber: input.contactNumber,
          deliveryAddress: input.deliveryAddress,
          notes: input.notes,
          bookingStatus: "Pending",
          paymentStatus: "Pending",
          createdAt: new Date().toISOString(),
        };

        const result = await rentalsCollection.insertOne(document, { session });

        booking = { ...document, _id: result.insertedId };
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      }
    );

    res.status(201).send({ message: "Booking created successfully", booking });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.status).send({ message: error.message });
    }

    console.log(error);
    res.status(500).send({ message: "Failed to create booking" });
  } finally {
    await session.endSession();
  }
});

// Creates a Stripe Checkout Session from a stored booking. No amount or
// equipment data is accepted from the browser here — everything is re-read
// from the booking document that was created by the validated booking API.
app.post("/create-checkout-session", ...customerAuth, async (req, res) => {
  try {
    const bookingId = getString(req.body?.bookingId);
    const customerEmail = req.user.email;

    if (!bookingId || !ObjectId.isValid(bookingId)) {
      return res.status(400).send({ message: "Invalid booking ID" });
    }

    const booking = await rentalsCollection.findOne({
      _id: new ObjectId(bookingId),
      customerEmail,
    });

    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }

    if (booking.paymentStatus === 'Paid') {
      return res.status(409).send({ message: "This booking is already paid" });
    }

    if (!stripe) {
      return res.status(500).send({ message: "Stripe is not configured" });
    }

    // Reuse an open session so repeated clicks never create duplicate charges.
    if (booking.stripeSessionId) {
      try {
        const existing = await stripe.checkout.sessions.retrieve(booking.stripeSessionId);

        if (
          existing.status === 'open' &&
          !existing.expired &&
          existing.url
        ) {
          return res.send({
            checkoutUrl: existing.url,
            sessionId: existing.id,
          });
        }
      } catch (error) {
        console.log('Stripe session lookup failed:', error.message);
      }
    }

    const currency = booking.stripeCurrency || STRIPE_CURRENCY;
    const amount = Number(booking.totalAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).send({ message: "Invalid booking amount" });
    }

    const metadata = {
      bookingId: booking._id.toString(),
      customerId: booking.customerId || '',
      equipmentId: (booking.equipmentIdString || booking.equipmentId || '').toString(),
      customerEmail: booking.customerEmail || '',
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: booking.customerEmail || undefined,
      client_reference_id: metadata.bookingId,
      line_items: [
        {
          price_data: {
            currency,
            unit_amount: toStripeMinorUnits(amount, currency),
            product_data: {
              name: booking.equipmentName || 'Equipment rental',
              description: `${booking.rentalDuration || 0} ${booking.rentalType || 'Daily'} rental`,
            },
          },
          quantity: 1,
        },
      ],
      metadata,
      payment_intent_data: { metadata },
      success_url: `${FRONTEND_URL}/payment/success?bookingId=${metadata.bookingId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/payment/cancel?bookingId=${metadata.bookingId}`,
    });

    if (!session.url) {
      return res.status(502).send({ message: "Stripe did not return a checkout URL" });
    }

    await rentalsCollection.updateOne(
      { _id: booking._id },
      {
        $set: {
          stripeSessionId: session.id,
          stripeCurrency: currency,
          stripeCheckoutUrl: session.url,
          paymentStatus: 'Pending',
          updatedAt: new Date().toISOString(),
        },
      }
    );

    res.send({ checkoutUrl: session.url, sessionId: session.id });
  } catch (error) {
    console.log('Checkout session error:', error);
    res.status(500).send({ message: 'Failed to create checkout session' });
  }
});

/**
 * Verifies a returned Stripe Checkout Session directly with Stripe before
 * marking a booking paid. The success page is NEVER trusted on its own: the
 * session id, booking id, amount and currency are all checked against Stripe
 * and the stored booking. Safe to call repeatedly.
 */
app.post('/verify-payment', ...customerAuth, async (req, res) => {
  try {
    const bookingId = getString(req.body?.bookingId);
    const sessionId = getString(req.body?.sessionId);
    const customerEmail = req.user.email;

    if (!bookingId || !ObjectId.isValid(bookingId) || !sessionId || !customerEmail) {
      return res.status(400).send({ message: 'Invalid payment verification request' });
    }

    if (!stripe) {
      return res.status(500).send({ message: 'Stripe is not configured' });
    }

    const booking = await rentalsCollection.findOne({
      _id: new ObjectId(bookingId),
      customerEmail,
    });

    if (!booking) {
      return res.status(404).send({ message: 'Booking not found' });
    }

    if (booking.stripeSessionId !== sessionId) {
      return res.status(400).send({ message: 'Checkout session mismatch' });
    }

    if (booking.paymentStatus === 'Paid' || booking.paymentStatus === 'Refunded') {
      return res.send({
        paymentStatus: booking.paymentStatus,
        bookingStatus: booking.bookingStatus,
        alreadyVerified: true,
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (
      session.client_reference_id !== bookingId &&
      session.metadata?.bookingId !== bookingId
    ) {
      return res.status(400).send({ message: 'Checkout session mismatch' });
    }

    const expectedCurrency = booking.stripeCurrency || STRIPE_CURRENCY;
    const expectedAmount = toStripeMinorUnits(booking.totalAmount, expectedCurrency);

    const paid =
      session.payment_status === 'paid' &&
      session.status === 'complete' &&
      session.currency === expectedCurrency &&
      session.amount_total === expectedAmount;

    if (!paid) {
      if (session.status === 'expired' && booking.paymentStatus === 'Pending') {
        await rentalsCollection.updateOne(
          { _id: booking._id, paymentStatus: 'Pending' },
          { $set: { paymentStatus: 'Failed', updatedAt: new Date().toISOString() } }
        );
      }

      return res.status(400).send({ message: 'Payment has not been confirmed by Stripe' });
    }

    await recordPaidBooking(booking, session, expectedCurrency, new Date().toISOString());

    const updated = await rentalsCollection.findOne({ _id: booking._id });

    return res.send({
      paymentStatus: updated.paymentStatus,
      bookingStatus: updated.bookingStatus,
      alreadyVerified: false,
    });
  } catch (error) {
    console.error('Payment verification error:', error);

    return res.status(500).send({ message: 'Failed to verify payment' });
  }
});

// Owner accepts a paid, pending booking. The ownerEmail filter makes the
// update atomic and ensures only the owner of the equipment can change it.
app.post('/bookings/:id/accept', ...ownerAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const ownerEmail = req.user.email;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid booking ID' });
    }

    const objectId = new ObjectId(id);
    const now = new Date().toISOString();

    const updated = await rentalsCollection.findOneAndUpdate(
      {
        _id: objectId,
        ownerEmail,
        paymentStatus: 'Paid',
        bookingStatus: 'Pending',
      },
      { $set: { bookingStatus: 'Confirmed', acceptedAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      const existing = await rentalsCollection.findOne({ _id: objectId, ownerEmail });

      if (!existing) {
        return res.status(404).send({ message: 'Booking not found for this owner' });
      }
      if (existing.paymentStatus !== 'Paid') {
        return res.status(409).send({ message: 'Payment must be completed before accepting' });
      }
      return res.status(409).send({ message: 'Only pending bookings can be accepted' });
    }

    return res.send({ message: 'Booking accepted successfully', booking: updated });
  } catch (error) {
    console.error('Accept booking error:', error);
    return res.status(500).send({ message: 'Failed to accept booking' });
  }
});

// Owner rejects an eligible pending booking. A Stripe refund is attempted for
// paid bookings, and paymentStatus becomes Refunded only when Stripe confirms
// the refund succeeded.
app.post('/bookings/:id/reject', ...ownerAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const ownerEmail = req.user.email;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid booking ID' });
    }

    const objectId = new ObjectId(id);
    const existing = await rentalsCollection.findOne({ _id: objectId, ownerEmail });

    if (!existing) {
      return res.status(404).send({ message: 'Booking not found for this owner' });
    }
    if (existing.bookingStatus !== 'Pending') {
      return res.status(409).send({ message: 'Only pending bookings can be rejected' });
    }

    let paymentStatus = existing.paymentStatus;
    let refundStatus = 'not_required';

    if (existing.paymentStatus === 'Paid') {
      if (!stripe || !existing.stripePaymentIntentId) {
        refundStatus = 'unavailable';
      } else {
        try {
          const refund = await stripe.refunds.create({
            payment_intent: existing.stripePaymentIntentId,
            reason: 'requested_by_customer',
          });

          if (refund.status === 'succeeded') {
            paymentStatus = 'Refunded';
            refundStatus = 'succeeded';

            await paymentsCollection.updateOne(
              { stripePaymentIntentId: existing.stripePaymentIntentId },
              {
                $set: {
                  paymentStatus: 'Refunded',
                  refundedAt: new Date().toISOString(),
                  stripeRefundId: refund.id,
                  amountRefunded: refund.amount || 0,
                },
              }
            );
          } else {
            refundStatus = 'pending';
          }
        } catch (refundError) {
          console.error('Stripe refund error:', refundError.message);
          refundStatus = 'failed';
        }
      }
    }

    const now = new Date().toISOString();

    const updated = await rentalsCollection.findOneAndUpdate(
      { _id: objectId, ownerEmail, bookingStatus: 'Pending' },
      {
        $set: {
          bookingStatus: 'Rejected',
          paymentStatus,
          rejectedAt: now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      return res.status(409).send({ message: 'This booking was already updated' });
    }

    return res.send({
      message: 'Booking rejected successfully',
      booking: updated,
      refundStatus,
    });
  } catch (error) {
    console.error('Reject booking error:', error);
    return res.status(500).send({ message: 'Failed to reject booking' });
  }
});

app.get("/customer/rentals", ...customerAuth, async (req, res) => {
  try {
    // Never trust a query email: bookings are scoped to the JWT identity.
    const customerEmail = req.user.email;

    await syncRentalProgress();

    const result = await rentalsCollection
      .find({ customerEmail })
      .sort({ _id: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to fetch rentals" });
  }
});

// Public equipment details and availability

app.get("/public/equipments/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid equipment ID" });
    }

    const equipment = await equipments.findOne({
      _id: new ObjectId(id),
      status: { $regex: /^approved$/i },
    });

    if (!equipment) {
      return res.status(404).send({ message: "Equipment not found" });
    }

    res.send(equipment);
  } catch (error) {
    console.log(error);

    res.status(500).send({ message: "Failed to fetch equipment" });
  }
});

app.get("/public/equipments/:id/availability", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid equipment ID" });
    }

    const equipment = await equipments.findOne({
      _id: new ObjectId(id),
      status: { $regex: /^approved$/i },
    });

    if (!equipment) {
      return res.status(404).send({ message: "Equipment not found" });
    }

    const start = new Date(getString(req.query.start));
    const end = new Date(getString(req.query.end));

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      return res.status(400).send({
        message: "Valid start and end dates are required",
      });
    }

    const activeBookings = await rentalsCollection
      .find({
        equipmentId: new ObjectId(id),
        bookingStatus: { $nin: ["Cancelled", "Rejected", "Completed"] },
        rentalStartDate: { $lte: start.toISOString() },
        rentalEndDate: { $gte: end.toISOString() },
      })
      .toArray();

    const reserved = activeBookings.reduce(
      (total, item) => total + Number(item.requiredQuantity || 0),
      0
    );
    const stock = Number(equipment.quantity || 0);
    const availableQuantity = Math.max(0, stock - reserved);

    res.send({
      stock,
      reserved,
      availableQuantity,
      available: availableQuantity > 0,
    });
  } catch (error) {
    console.log(error);

    res.status(500).send({ message: "Failed to check availability" });
  }
});


// Admin API
const SAFE_USER_PROJECTION = {
  _id: 1,
  name: 1,
  email: 1,
  role: 1,
  phone: 1,
  address: 1,
  image: 1,
  emailVerified: 1,
  createdAt: 1,
  updatedAt: 1,
};

function toAdminUserDto(doc) {
  return {
    id: String(doc._id),
    name: getString(doc.name),
    email: getString(doc.email),
    role: USER_ROLES.includes(doc.role) ? doc.role : "customer",
    phone: getString(doc.phone),
    address: getString(doc.address),
    image: typeof doc.image === "string" ? doc.image : null,
    emailVerified: Boolean(doc.emailVerified),
    createdAt: toISO(doc.createdAt),
    updatedAt: toISO(doc.updatedAt),
  };
}

app.get("/admin/users", ...adminAuth, async (req, res) => {
  try {
    const query = {};
    const search = getQueryString(req.query.search);
    const role = getQueryString(req.query.role);

    if (search) {
      const pattern = escapeRegex(search);
      query.$or = [
        { name: { $regex: pattern, $options: "i" } },
        { email: { $regex: pattern, $options: "i" } },
      ];
    }
    if (USER_ROLES.includes(role)) query.role = role;

    const docs = await users
      .find(query, { projection: SAFE_USER_PROJECTION })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    res.send({ users: docs.map(toAdminUserDto), total: docs.length });
  } catch (error) {
    return sendApiError(res, error, "Failed to load users");
  }
});

app.patch("/admin/users/:id/role", ...adminAuth, async (req, res) => {
  try {
    const id = getString(req.params.id);
    const role = getString(req.body?.role);
    const actingAdminId = getActingAdminId(req);

    if (!id || !ObjectId.isValid(id)) throw new ApiError(400, "Invalid user ID");
    if (!USER_ROLES.includes(role)) {
      throw new ApiError(400, "Please choose a valid role");
    }

    // Better Auth stores user _id as an ObjectId, while the DTO exposes it as
    // a hex string. Convert before querying or the lookup always misses.
    const objectId = new ObjectId(id);
    const user = await users.findOne(
      { _id: objectId },
      { projection: SAFE_USER_PROJECTION }
    );

    if (!user) throw new ApiError(404, "User not found");

    // An admin cannot remove their own admin access. This is checked again
    // here (not only in the Next.js action) so the rule holds even if the
    // trusted caller forwards a different acting id.
    if (id === actingAdminId && role !== "admin") {
      throw new ApiError(409, "You cannot change your own admin role");
    }

    const updated = await users.findOneAndUpdate(
      { _id: objectId },
      { $set: { role, updatedAt: new Date().toISOString() } },
      { returnDocument: "after", projection: SAFE_USER_PROJECTION }
    );

    if (!updated) throw new ApiError(404, "User not found");

    res.send({
      message: "User role updated successfully",
      user: toAdminUserDto(updated),
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to update user role");
  }
});

app.delete("/admin/users/:id", ...adminAuth, async (req, res) => {
  try {
    const id = getString(req.params.id);
    const actingAdminId = getActingAdminId(req);

    if (!id || !ObjectId.isValid(id)) throw new ApiError(400, "Invalid user ID");
    if (id === actingAdminId) {
      throw new ApiError(409, "You cannot delete your own account");
    }

    const objectId = new ObjectId(id);
    const user = await users.findOne(
      { _id: objectId },
      { projection: SAFE_USER_PROJECTION }
    );

    if (!user) throw new ApiError(404, "User not found");

    if (user.role === "admin") {
      const adminCount = await users.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        throw new ApiError(409, "The last admin account cannot be deleted");
      }
    }

    // Some Better Auth versions store userId as a string, others as ObjectId.
    // Match both so no session or account survives an account deletion.
    const ownerFilter = { $in: [objectId, id] };

    await Promise.all([
      sessionsCollection.deleteMany({ userId: ownerFilter }),
      accountsCollection.deleteMany({ userId: ownerFilter }),
    ]);

    const result = await users.deleteOne({ _id: objectId });

    if (result.deletedCount === 0) throw new ApiError(404, "User not found");

    res.send({
      message: "User deleted successfully",
      result: { deletedCount: result.deletedCount },
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to delete user");
  }
});

app.get("/admin/equipments", ...adminAuth, async (req, res) => {
  try {
    const query = {};
    const status = getQueryString(req.query.status);
    const search = getQueryString(req.query.search);

    if (["Pending", "Approved", "Rejected"].includes(status)) {
      query.status = status;
    }
    if (search) {
      const pattern = escapeRegex(search);
      query.$or = [
        { name: { $regex: pattern, $options: "i" } },
        { "ownerInfo.email": { $regex: pattern, $options: "i" } },
      ];
    }

    const docs = await equipments
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    res.send({
      equipments: docs.map((item) => ({ ...item, _id: String(item._id) })),
      total: docs.length,
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to load equipment");
  }
});

app.patch("/admin/equipments/:id/status", ...adminAuth, async (req, res) => {
  try {
    const id = getString(req.params.id);
    const status = getString(req.body?.status);

    if (!id || !ObjectId.isValid(id)) {
      throw new ApiError(400, "Invalid equipment ID");
    }
    if (!["Pending", "Approved", "Rejected"].includes(status)) {
      throw new ApiError(400, "Please choose a valid equipment status");
    }

    const updated = await equipments.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date().toISOString(),
          reviewedAt: new Date().toISOString(),
          reviewedBy: getActingAdminId(req) || "admin",
        },
      },
      { returnDocument: "after" }
    );

    if (!updated) throw new ApiError(404, "Equipment not found");

    res.send({
      message: `Equipment ${status.toLowerCase()} successfully`,
      equipment: { ...updated, _id: String(updated._id) },
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to update equipment status");
  }
});

app.patch("/admin/equipments/:id", ...adminAuth, async (req, res) => {
  try {
    const id = getString(req.params.id);

    if (!id || !ObjectId.isValid(id)) {
      throw new ApiError(400, "Invalid equipment ID");
    }

    const updates = buildEquipmentUpdates(req.body);
    updates.updatedAt = new Date().toISOString();

    const updated = await equipments.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: "after" }
    );

    if (!updated) throw new ApiError(404, "Equipment not found");

    res.send({
      message: "Equipment updated successfully",
      equipment: { ...updated, _id: String(updated._id) },
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to update equipment");
  }
});

app.delete("/admin/equipments/:id", ...adminAuth, async (req, res) => {
  try {
    const id = getString(req.params.id);

    if (!id || !ObjectId.isValid(id)) {
      throw new ApiError(400, "Invalid equipment ID");
    }

    const result = await equipments.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) throw new ApiError(404, "Equipment not found");

    res.send({
      message: "Equipment deleted successfully",
      result: { deletedCount: result.deletedCount },
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to delete equipment");
  }
});

app.get("/admin/rentals", ...adminAuth, async (req, res) => {
  try {
    await syncRentalProgress();

    const query = {};
    const bookingStatus = getQueryString(req.query.bookingStatus);
    const paymentStatus = getQueryString(req.query.paymentStatus);
    const search = getQueryString(req.query.search);

    if (bookingStatus) query.bookingStatus = bookingStatus;
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (search) {
      const pattern = escapeRegex(search);
      query.$or = [
        { customerEmail: { $regex: pattern, $options: "i" } },
        { ownerEmail: { $regex: pattern, $options: "i" } },
        { equipmentName: { $regex: pattern, $options: "i" } },
      ];
    }

    const requestedPage = Number.parseInt(getQueryString(req.query.page), 10);
    const requestedLimit = Number.parseInt(getQueryString(req.query.limit), 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), 50)
        : 10;

    const [docs, total] = await Promise.all([
      rentalsCollection
        .find(query)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      rentalsCollection.countDocuments(query),
    ]);

    
    const emails = new Set();
    for (const doc of docs) {
      if (doc.customerEmail) emails.add(String(doc.customerEmail).toLowerCase());
      if (doc.ownerEmail) emails.add(String(doc.ownerEmail).toLowerCase());
    }

    const nameDocs = emails.size
      ? await users
          .find({ email: { $in: [...emails] } }, { projection: { name: 1, email: 1, _id: 0 } })
          .toArray()
      : [];

    const nameByEmail = new Map(
      nameDocs.map((item) => [getString(item.email).toLowerCase(), getString(item.name)])
    );

    const rentals = docs.map((doc) => ({
      ...doc,
      _id: String(doc._id),
      equipmentId: doc.equipmentId ? String(doc.equipmentId) : doc.equipmentIdString || undefined,
      customerName:
        getString(doc.customerName) ||
        nameByEmail.get(String(doc.customerEmail || "").toLowerCase()) ||
        "",
      ownerName: nameByEmail.get(String(doc.ownerEmail || "").toLowerCase()) || "",
      createdAt: toISO(doc.createdAt),
      paidAt: toISO(doc.paidAt),
    }));

    res.send({
      rentals,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to load rentals");
  }
});

app.patch("/admin/rentals/:id/booking-status", ...adminAuth, async (req, res) => {
  try {
    const id = getString(req.params.id);
    const nextStatus = getString(req.body?.bookingStatus);

    if (!id || !ObjectId.isValid(id)) {
      throw new ApiError(400, "Invalid booking ID");
    }

    const objectId = new ObjectId(id);
    const booking = await rentalsCollection.findOne({ _id: objectId });

    if (!booking) throw new ApiError(404, "Booking not found");

    const currentStatus = getString(booking.bookingStatus) || "Pending";
    const allowed = ADMIN_BOOKING_TRANSITIONS[currentStatus] || [];

    if (!allowed.includes(nextStatus)) {
      throw new ApiError(
        409,
        `Cannot change a ${currentStatus.toLowerCase()} booking to ${nextStatus.toLowerCase() || "that status"}`
      );
    }

    if (
      ["Cancelled", "Rejected"].includes(nextStatus) &&
      booking.paymentStatus === "Paid"
    ) {
      throw new ApiError(
        409,
        "Paid bookings must be handled through the refund workflow"
      );
    }

    const now = new Date().toISOString();
    const updated = await rentalsCollection.findOneAndUpdate(
      { _id: objectId, bookingStatus: currentStatus },
      {
        $set: {
          bookingStatus: nextStatus,
          updatedAt: now,
          ...(nextStatus === "Cancelled" ? { cancelledAt: now } : {}),
          reviewedBy: getActingAdminId(req) || "admin",
        },
      },
      { returnDocument: "after" }
    );

    if (!updated) {
      throw new ApiError(409, "This booking changed. Refresh and try again.");
    }

    res.send({
      message: `Booking marked ${nextStatus.toLowerCase()} successfully`,
      booking: { ...updated, _id: String(updated._id) },
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to update booking status");
  }
});

// ---------------------------------------------------------------------------
// Analytics (JWT + role protected)
// ---------------------------------------------------------------------------

app.get('/owner/analytics', ...ownerAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const rentals = await rentalsCollection
      .find({ ownerEmail: email })
      .toArray();

    const equipmentCount = await equipments.countDocuments({
      "ownerInfo.email": email,
    });

    res.send({
      equipmentCount,
      rentalCount: rentals.length,
      pendingRequests: rentals.filter((item) => item.bookingStatus === "Pending").length,
      earnings: rentals
        .filter((item) => item.paymentStatus === "Paid")
        .reduce((sum, item) => sum + Number(item.totalAmount || 0), 0),
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to load owner analytics");
  }
});

app.get('/admin/analytics', ...adminAuth, async (req, res) => {
  try {
    const [userCount, pending, approved, rejected, rentalCount, paidRentals] =
      await Promise.all([
        users.countDocuments({}),
        equipments.countDocuments({ status: "Pending" }),
        equipments.countDocuments({ status: "Approved" }),
        equipments.countDocuments({ status: "Rejected" }),
        rentalsCollection.countDocuments({}),
        rentalsCollection.find({ paymentStatus: "Paid" }).toArray(),
      ]);

    res.send({
      userCount,
      equipment: { pending, approved, rejected },
      rentalCount,
      revenue: paidRentals.reduce(
        (sum, item) => sum + Number(item.totalAmount || 0),
        0
      ),
    });
  } catch (error) {
    return sendApiError(res, error, "Failed to load admin analytics");
  }
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});