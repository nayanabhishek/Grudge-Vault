import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const webOrigins = process.env.WEB_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (process.env.NODE_ENV === "production" && !webOrigins?.length) {
    throw new Error("WEB_ORIGIN must list the allowed frontend origin(s) in production.");
  }
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: webOrigins?.length ? webOrigins : ["http://localhost:5173"], credentials: false });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
