import express from 'express';
import cors from 'cors'


const app = express();
const port = process.env.PORT || 5000;

app.use(express.json())
app.use(cors())



app.get('/', (req, res) => {
  res.send('hello from the server');
});

app.listen(port, () => {
  console.log(`server is running on port ${port}`);
});