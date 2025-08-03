const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Middlewares
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

// const serviceAccount = require("./firebase_admin.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.eztfylz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        const userCollection = client.db("metronest").collection("users");
        const propertiesCollection = client.db("metronest").collection("properties");
        const reviewsCollection = client.db("metronest").collection("reviews");
        const wishlistCollection = client.db("metronest").collection("wishlists");
        const offersCollection = client.db("metronest").collection("offers");

        // verification start 
        const verifyToken = async (req, res, next) => {
            const authHeader = req.headers.authorization;
            // console.log('heade in middle ware ', authHeader)
            //5 use this as middleware in
            if (!authHeader) {
                return res.status(401).send({ message: 'unauthorized access' })
            }
            const token = authHeader.split(' ')[1]
            if (!token) {
                return res.status(401).send({ message: 'unauthorized access' })
            }

            // 6.now verify the token go to firebase // service center
            // 7.install firebase admin 
            //10
            try {
                const decodedToken = await admin.auth().verifyIdToken(token);
                req.decoded = decodedToken;
                next();
            } catch (error) {
                return res.status(403).send({ message: 'Forbidden access', error: error.message });
            }
        }

        // -------    ///user Collection /----------------
        //  User
        app.post('/users', async (req, res) => {
            const userInfo = req.body;
            // console.log(parcel)
            const result = await userCollection.insertOne(userInfo);
            res.send(result)
        });

        // get all users 
        app.get('/users',verifyToken, async (req, res) => {
            const users = await userCollection.find().toArray();
            res.send(users);
        });

        // get user role 
        // inside Express
        app.get('/users/role/:email',verifyToken, async (req, res) => {
            const email = req.params.email;
            const user = await userCollection.findOne({ email });
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            res.json({ role: user.role });
        });

        // delete user  from mongo db and firebase 
        app.delete('/users/:id', async (req, res) => {
            const id = req.params.id;
            const { email } = req.query;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'Invalid user ID' });
            }

            try {
                // Remove from MongoDB
                const result = await userCollection.deleteOne({ _id: new ObjectId(id) });

                // Remove from Firebase
                try {
                    const userRecord = await admin.auth().getUserByEmail(email);
                    await admin.auth().deleteUser(userRecord.uid);
                } catch (firebaseError) {
                    if (firebaseError.code === 'auth/user-not-found') {
                        console.warn('User not found in Firebase, skipping Firebase delete.');
                    } else {
                        throw firebaseError; // Bubble up other errors
                    }
                }

                res.send({ message: 'User deleted from DB and Firebase', result });
            } catch (error) {
                console.error('Error deleting user:', error);
                res.status(500).send({ message: 'Failed to delete user' });
            }
        });


        //  mark  as fraud 
        app.put('/users/fraud/:id', async (req, res) => {
            const id = req.params.id;

            // Get user first
            const user = await userCollection.findOne({ _id: new ObjectId(id) });
            if (!user || user.role !== 'agent') {
                return res.status(400).send({ message: 'User is not an agent' });
            }

            // Mark fraud
            await userCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { role: 'fraud' } }
            );

            // Delete their verified properties
            await propertiesCollection.deleteMany({ agentEmail: user.email, status: 'verified' });

            res.send({ message: 'User marked as fraud and properties removed' });
        });




        // make admin and agent 
        app.put('/users/role/:id', async (req, res) => {
            const { role } = req.body; // 'admin' or 'agent'
            const id = req.params.id;
            const result = await userCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { role } }
            );
            res.send(result);
        });

        // mark as farud and  delete property 
        app.put('/users/fraud/:id', async (req, res) => {
            const id = req.params.id;

            // Get user first
            const user = await userCollection.findOne({ _id: new ObjectId(id) });
            if (!user || user.role !== 'agent') {
                return res.status(400).send({ message: 'User is not an agent' });
            }

            // Mark fraud
            await userCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { role: 'fraud' } }
            );

            // Delete their verified properties
            await propertiesCollection.deleteMany({ agentEmail: user.email, status: 'verified' });

            res.send({ message: 'User marked as fraud and properties removed' });
        });



        // --------------PRoperties-------------------------------
        // POST /properties - Add a new property
        app.post('/properties', async (req, res) => {
            try {
                const property = req.body;

                // ✅ Basic validation
                if (!property.title || !property.location || !property.image || !property.agentEmail) {
                    return res.status(400).json({ message: 'Missing required fields' });
                }

                // ✅ Check if the user (agent) is fraud
                const agent = await userCollection.findOne({ email: property.agentEmail });

                if (!agent) {
                    return res.status(404).json({ message: 'Agent not found' });
                }

                if (agent.role === 'fraud') {
                    return res.status(403).json({ message: 'Fraud agents are not allowed to add properties' });
                }

                // ✅ Insert into MongoDB
                const result = await propertiesCollection.insertOne(property);

                res.status(201).json({
                    message: 'Property added successfully',
                    propertyId: result.insertedId,
                });
            } catch (error) {
                console.error('Error adding property:', error);
                res.status(500).json({ message: 'Internal server error' });
            }
        });

        app.get('/all-properties',verifyToken, async (req, res) => {
            const result = await propertiesCollection.find().toArray();
            res.send(result)
        })

        // fetch advertised properties 
        app.get('/properties/advertised',verifyToken, async (req, res) => {
            const result = await propertiesCollection
                .find({ isAdvertised: true, status: 'verified' })
                .limit(4)
                .toArray();
            res.send(result);
        });


        // GET /properties/verified - Only get verified properties
        app.get('/properties/verified',verifyToken, async (req, res) => {
            try {
                const result = await propertiesCollection.find({ status: 'verified' }).toArray();
                res.send(result);
            } catch (error) {
                console.error('Failed to fetch verified properties', error);
                res.status(500).send({ message: 'Internal server error' });
            }
        });
        // properties find with email
        app.get('/properties',verifyToken, async (req, res) => {
            const email = req.query.email;
            if (!email) return res.status(400).send({ message: 'Email query required' });

            const properties = await propertiesCollection.find({ agentEmail: email }).toArray();
            res.send(properties);
        });

        // DELETE properties
        app.delete('/properties/:id', async (req, res) => {
            const id = req.params.id;
            // console.log(id)
            const result = await propertiesCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        app.get('/properties/:id',verifyToken, async (req, res) => {
            const id = req.params.id
            const result = await propertiesCollection.findOne({ _id: new ObjectId(id) })
            res.send(result)
        })
        // updating properties 

        app.put('/properties/:id', async (req, res) => {
            const id = req.params.id;
            const {
                title,
                location,
                image,
                priceMin,
                priceMax,
                agentName,
                agentEmail,
                status,
            } = req.body;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({ message: 'Invalid property ID' });
            }

            if (!title || !location || !image || !agentName || !agentEmail) {
                return res.status(400).json({ message: 'Missing required fields' });
            }

            if (
                typeof priceMin !== 'number' ||
                typeof priceMax !== 'number' ||
                priceMin < 1 ||
                priceMax < priceMin
            ) {
                return res.status(400).json({ message: 'Invalid price range' });
            }

            try {
                // Prevent updating if status is rejected (optional, add as per your logic)
                const existingProperty = await propertiesCollection.findOne({ _id: new ObjectId(id) });
                if (!existingProperty) {
                    return res.status(404).json({ message: 'Property not found' });
                }
                if (existingProperty.status === 'rejected') {
                    return res.status(403).json({ message: 'Rejected property cannot be updated' });
                }

                const updateDoc = {
                    $set: {
                        title,
                        location,
                        image,
                        priceMin,
                        priceMax,
                        agentName,
                        agentEmail,
                        status, // Keep the status unchanged or updated if you allow it
                        updatedAt: new Date().toISOString(),
                    },
                };

                const result = await propertiesCollection.updateOne(
                    { _id: new ObjectId(id) },
                    updateDoc
                );

                if (result.modifiedCount === 1) {
                    res.json({ message: 'Property updated successfully' });
                } else {
                    res.status(500).json({ message: 'Failed to update property' });
                }
            } catch (error) {
                console.error('Update property error:', error);
                res.status(500).json({ message: 'Server error' });
            }
        });

        // / PUT /properties/status/:id - update verification status
        app.put('/properties/status/:id', async (req, res) => {
            const id = req.params.id;
            const { status } = req.body;

            if (!['verified', 'rejected'].includes(status)) {
                return res.status(400).send({ message: 'Invalid status' });
            }

            const result = await propertiesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status } }
            );

            res.send(result);
        });


        //  All sold properties for a specific agent
        app.get('/sold-properties/:agentEmail',verifyToken, async (req, res) => {
            const agentEmail = req.params.agentEmail;
            try {
                const soldOffers = await offersCollection.find({
                    agentEmail: agentEmail,
                    status: 'bought'
                }).toArray();

                res.send(soldOffers);
            } catch (error) {
                res.status(500).send({ message: 'Error fetching sold properties', error });
            }
        });

        // Advertise properties 

        //  advertise a property (admin only)
        app.patch('/properties/advertise/:id', async (req, res) => {
            const id = req.params.id;
            const result = await propertiesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { isAdvertised: true } }
            );
            res.send(result);
        });


        // ------post riveiw -------------------------------------
        app.post('/reviews', async (req, res) => {
            const review = req.body;
            console.log(review)
            if (!review.propertyId || !review.userEmail || !review.reviewText) {
                return res.status(400).send({ message: 'Missing fields' });
            }
            review.createdAt = new Date().toISOString();
            const result = await reviewsCollection.insertOne(review);
            res.send(result);
        });

        //  latest 4 user reviews
        app.get('/reviews/latest',verifyToken, async (req, res) => {
            try {
                const latestReviews = await reviewsCollection
                    .find()
                    .sort({ reviewedAt: -1 })
                    .limit(4)
                    .toArray();
                res.send(latestReviews);
            } catch (err) {
                res.status(500).send({ message: 'Failed to fetch latest reviews' });
            }
        });

        //All reviews (Admin only)
        app.get('/admin/reviews',verifyToken, async (req, res) => {
            try {
                const reviews = await reviewsCollection.find().sort({ reviewedAt: -1 }).toArray();
                res.send(reviews);
            } catch (err) {
                res.status(500).send({ message: 'Failed to fetch reviews' });
            }
        });




        //    get reivew by id 

        //  get all reviews for a specific property made by users only
        app.get('/reviews/:propertyId',verifyToken, async (req, res) => {
            const propertyId = req.params.propertyId;

            try {
                const reviews = await reviewsCollection
                    .find({ propertyId: propertyId, role: 'user' }) // ✅ Only user reviews
                    .sort({ createdAt: -1 }) // optional: latest first
                    .toArray();

                res.send(reviews);
            } catch (error) {
                console.error('Error fetching user reviews:', error);
                res.status(500).send({ message: 'Failed to fetch user reviews' });
            }
        });

        //  Get all reviews by a specific user
        app.get('/my-reviews/:email', verifyToken,async (req, res) => {
            const email = req.params.email;
            const result = await reviewsCollection.find({ userEmail: email }).toArray();
            res.send(result);
        });


        //  Delete a review by ID
        app.delete('/reviews/:id', async (req, res) => {
            const id = req.params.id;
            const result = await reviewsCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        //  delete review by ID (Admin only)
        app.delete('/admin/reviews/:id', async (req, res) => {
            const id = req.params.id;
            try {
                const result = await reviewsCollection.deleteOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (err) {
                res.status(500).send({ message: 'Failed to delete review' });
            }
        });





        //--------------------wihlist --------------------

        app.post('/wishlist', async (req, res) => {
            const { userEmail, propertyId, propertyInfo } = req.body;

            if (!userEmail || !propertyId) {
                return res.status(400).send({ message: 'Missing data' });
            }

            const exists = await wishlistCollection.findOne({ userEmail, propertyId });
            if (exists) {
                return res.status(409).send({ message: 'Already in wishlist' });
            }

            const result = await wishlistCollection.insertOne({
                userEmail,
                propertyId,
                propertyInfo,
                addedAt: new Date().toISOString(),
            });
            res.send(result);
        });


        // Get wishlist by user email
        app.get('/wishlist',verifyToken, async (req, res) => {
            const email = req.query.email;
            console.log(email)
            const result = await wishlistCollection.find({
                userEmail: email
            }).toArray();
            res.send(result);
        });

        // get one item with wishlist 
        // Get a single wishlist item by ID
        app.get('/wishlist-item/:id',verifyToken, async (req, res) => {
            const id = req.params.id;
            try {
                const item = await wishlistCollection.findOne({ _id: new ObjectId(id) });

                if (!item) {
                    return res.status(404).send({ message: 'Wishlist item not found' });
                }

                res.send(item); // or res.send(item.propertyInfo); if you only want propertyInfo
            } catch (error) {
                console.error('Error getting wishlist item:', error);
                res.status(500).send({ message: 'Failed to fetch wishlist item' });
            }
        });


        // Remove from wishlist
        app.delete('/wishlist/:id', async (req, res) => {
            const id = req.params.id;
            const result = await wishlistCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        // ----------offer section --------------------
        app.post('/offers', async (req, res) => {
            const {
                propertyId,
                propertyTitle,
                propertyLocation,
                agentName,
                agentEmail,
                propertyImage,
                buyerName,
                buyerEmail,
                offerAmount,
                buyingDate,
            } = req.body;

            console.log(propertyId)
            console.log(agentEmail)

            try {
                // Get user role by email
                const user = await userCollection.findOne({ email: buyerEmail });
                if (!user || user.role !== 'user') {
                    return res.status(403).send({ message: 'Only regular users can make an offer.' });
                }

                // Get property to validate price range
                const property = await propertiesCollection.findOne({ _id: new ObjectId(propertyId) });
                if (!property) {
                    return res.status(404).send({ message: 'Property not found.' });
                }

                if (
                    typeof offerAmount !== 'number' ||
                    offerAmount < property.priceMin ||
                    offerAmount > property.priceMax
                ) {
                    return res.status(400).send({ message: 'Offer amount is outside the allowed range.' });
                }

                const offer = {
                    propertyId,
                    propertyTitle,
                    propertyLocation,
                    agentName,
                    agentEmail,
                    propertyImage,
                    buyerName,
                    buyerEmail,
                    offerAmount,
                    buyingDate,
                    status: 'pending',
                    offeredAt: new Date(),
                };

                const result = await offersCollection.insertOne(offer);
                res.send({ message: 'Offer placed successfully', offerId: result.insertedId });
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: 'Failed to make offer' });
            }
        });

        //  GET all offers made to a specific agent
        app.get('/offers/agent/:email',verifyToken, async (req, res) => {
            const email = req.params.email;
            const query = { agentEmail: email };
            const result = await offersCollection.find(query).toArray();
            res.send(result);
        });


        //  PUT: Accept offer by ID and reject others automatically
        app.put('/offers/accept/:id', async (req, res) => {
            const id = req.params.id;

            // ✅ 1. Get current offer
            const currentOffer = await offersCollection.findOne({ _id: new ObjectId(id) });
            if (!currentOffer) return res.status(404).send({ message: "Offer not found" });

            const propertyId = currentOffer.propertyId;

            // ✅ 2. Accept current offer
            await offersCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status: "accepted" } }
            );

            // ✅ 3. Reject other offers for same property
            await offersCollection.updateMany(
                { propertyId: propertyId, _id: { $ne: new ObjectId(id) } },
                { $set: { status: "rejected" } }
            );

            res.send({ message: "Offer accepted and others rejected" });
        });

        // PUT: Reject single offer
        app.put('/offers/reject/:id', async (req, res) => {
            const id = req.params.id;
            const result = await offersCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { status: "rejected" } }
            );
            res.send(result);
        });

        app.get('/offers/user',verifyToken, async (req, res) => {
            const email = req.query.email;
            if (!email) return res.status(400).send({ message: 'Email is required' });

            const result = await offersCollection
                .find({ buyerEmail: email })
                .sort({ offeredAt: -1 })
                .toArray();

            res.send(result);
        });
        // Get offer by ID
        app.get('/offers/:id',verifyToken, async (req, res) => {
            const id = req.params.id;
            const result = await offersCollection.findOne({ _id: new ObjectId(id) });
            res.send(result);
        });




        // payment intent 
        //  POST: Create Stripe Payment Intent
        app.post('/create-payment-intent', async (req, res) => {
            const { amount } = req.body;

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount * 100, // Stripe accepts amount in cents
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        // Mark offer as paid
        app.put('/offers/mark-paid/:id', async (req, res) => {
            const id = req.params.id;
            const { transactionId } = req.body;

            const result = await offersCollection.updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: {
                        status: 'bought',
                        transactionId,
                    }
                }
            );

            res.send(result);
        });


        await client.connect();
        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);






// Sample route
app.get('/', (req, res) => {
    res.send('MetroNest Backend Running');
});

app.listen(port, () => {
    console.log(`Metronest is running on port ${port}`);
});
