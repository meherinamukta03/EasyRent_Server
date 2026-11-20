import express from 'express';
import cors from 'cors'
import 'dotenv/config'

import { MongoClient } from 'mongodb';


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