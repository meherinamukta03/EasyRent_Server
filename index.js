import express from 'express';
import cors from 'cors'
import 'dotenv/config'

import { MongoClient, ObjectId } from 'mongodb';


const app = express();
const port = process.env.PORT || 5000;

app.use(express.json())
app.use(cors())

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



app.get('/', (req, res) => {
  res.send('hello from the server');
});

app.get('/users', async(req, res) => {
const user=users.find({})
const result=await user.toArray()
  res.send(result);
});



















//ower

app.post('/equipments',async(req,res)=>{
  const job = req.body;
    const result = await equipments.insertOne(job);
    res.send(result);
})

app.get("/equipments", async (req, res) => {
  try {
    const email = req.query.email;

    const result = await equipments.find({ "ownerInfo.email": email })
      .toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to get equipment",
    });
  }
});

app.patch('/equipments/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ownerEmail = req.body?.ownerEmail;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid equipment ID"
      });
    }

    if (!ownerEmail) {
      return res.status(401).send({
        message: "Owner email is required"
      });
    }

    const editableFields = [
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
      "image"
    ];

    const updates = {};

    for (const field of editableFields) {
      if (req.body[field] !== undefined && req.body[field] !== null) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).send({
        message: "No editable fields were provided"
      });
    }

    const result = await equipments.findOneAndUpdate(
      {
        _id: new ObjectId(id),
        "ownerInfo.email": ownerEmail
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
    console.log(error);

    res.status(500).send({
      message: "Failed to update equipment"
    });
  }
});

app.delete('/equipments/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ownerEmail = req.query.email;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid equipment ID"
      });
    }

    if (!ownerEmail) {
      return res.status(401).send({
        message: "Owner email is required"
      });
    }

    const query = {
      _id: new ObjectId(id),
      "ownerInfo.email": ownerEmail
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


app.get("/owner/rentals", async (req, res) => {
  try {
    const email = req.query.email;

   
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


app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});