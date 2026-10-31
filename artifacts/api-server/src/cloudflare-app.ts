import express, { type Express, type Request } from "express";
import router from "./routes";

const app: Express = express();
app.use("/api", router);

export default app;
