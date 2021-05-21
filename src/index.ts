/* eslint-disable require-jsdoc */
import * as functions from "firebase-functions";
import * as firebase from "firebase-admin";
import Stripe from "stripe";

const stripe = new Stripe(functions.config().stripe.sk_key, {apiVersion: "2020-08-27"});
firebase.initializeApp();

const db = firebase.firestore();
// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
interface IProduct {
    id: string;
    qty: number;
    cost: number;
    name: string;
}

function getRandom(arr: any[], n: number) {
  const result = new Array(n);
  let len = arr.length;
  const taken = new Array(len);
  if (n > len) {
    throw new RangeError("getRandom: more elements taken than available");
  }
  while (n--) {
    const x = Math.floor(Math.random() * len);
    result[n] = arr[x in taken ? taken[x] : x];
    taken[x] = --len in taken ? taken[len] : len;
  }
  return result;
}
/**
 *
 * @param {string} productId the product id
 * @param {number} amount the amount of stock to change
 */
function changeStock(productId: string, amount: number) {
  db.collection("products").doc(productId).update({stock: firebase.firestore.FieldValue.increment(amount)});
}


async function fulfillOrder(product:IProduct, uid: string) {
  const {orderId} = (await db.collection("data").doc("lastOrderId").get()).data() as {orderId: string};
  db.collection("data").doc("lastOrderId").update({orderId: firebase.firestore.FieldValue.increment(1)});
  // const {stock} = (await db.collection("stocks").doc(product.id).get()).data() as {orderId: string};

  const {instant} = (await db.collection("products").doc(product.id).get()).data() as {instant: boolean};


  if (!instant) {
    const refOrder = await db.collection("orders").add({
      date: Date.now(),
      deliveryId: "",
      fulfilled: false,
      orderId,
      productId: product.id,
      productName: product.name,
      quantity: product.qty,
      uid,
    });
    const refDelivery = await db.collection("deliveries").add({
      data: "",
      orderId: refOrder.id,
    });
    await refOrder.update({deliveryId: refDelivery.id});

    return true;
  }

  const a = await db.collection("stocks").where("productId", "==", product.id).get();
  let stock: string[] = [];
  let ref: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData> | undefined;
  a.forEach((r)=>{
    stock = r.data().stock;
    ref = r.ref;
  });
  if (!ref) {
    return false;
  }


  const selectedDelivery = getRandom(stock, product.qty);
  ref.update({
    alreadySold: firebase.firestore.FieldValue.arrayUnion(...selectedDelivery),
    stock: firebase.firestore.FieldValue.arrayRemove(...selectedDelivery),
  });
  const refOrder = await db.collection("orders").add({
    date: firebase.firestore.FieldValue.serverTimestamp(),
    deliveryId: "",
    fulfilled: true,
    orderId,
    productId: product.id,
    productName: product.name,
    quantity: product.qty,
    uid,
  });
  const refDelivery = await db.collection("deliveries").add({
    data: selectedDelivery.join("::|::"),
    orderId: refOrder.id,
  });
  await refOrder.update({deliveryId: refDelivery.id});
  return true;
}


// eslint-disable-next-line camelcase
export const pay = functions.https.onCall(async (data: {payment_method_id: string, payment_intent_id: string, product: IProduct}, context)=>{
  // ok
  if (!context.auth?.uid) {
    return {error: "You need to be logged"};
  }

  const {product} = data;
  const {stock} = (await db.collection("products").doc(product.id).get()).data() as {stock: number};
  if (stock < product.qty) {
    return {error: "OOS"};
  }
  changeStock(product.id, -product.qty);

  try {
    let intent;
    if (data.payment_method_id) {
      // Create the PaymentIntent
      intent = await stripe.paymentIntents.create({
        payment_method: data.payment_method_id,
        amount: 1099,
        currency: "usd",
        confirmation_method: "manual",
        confirm: true,
      });
    } else if (data.payment_intent_id) {
      intent = await stripe.paymentIntents.confirm(
          data.payment_intent_id
      );
    }
    // Send the response to the client

    if (!intent) {
      changeStock(product.id, product.qty);

      return {error: "Unexpected error"};
    }

    if (
      intent.status === "requires_action" &&
    intent.next_action?.type === "use_stripe_sdk"
    ) {
    // Tell the client to handle the action
      changeStock(product.id, product.qty);

      return {
        requires_action: true,
        payment_intent_client_secret: intent.client_secret,
      };
    } else if (intent.status === "succeeded") {
    // The payment didn’t need any additional actions and completed!
    // Handle post-payment fulfillment
      // Deliver the order

      return {
        success: (await fulfillOrder(product, context.auth.uid)),
      };
    } else {
    // Invalid status
      changeStock(product.id, product.qty);

      return {
        error: "Invalid PaymentIntent status",
      };
    }
  } catch (e) {
    // Display error on client
    changeStock(product.id, product.qty);

    return {error: e.message};
  }
});

