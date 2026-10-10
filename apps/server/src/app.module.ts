import { Module } from "@nestjs/common";
import { AppController } from "./app.controller.js";
import { GameGateway } from "./game.gateway.js";
import { GameService } from "./game.service.js";
import { GAME_STORE, SQLITE_DATABASE, SqliteGameStore, createSqlitePool } from "./sqlite-game-store.js";

@Module({
  controllers: [AppController],
  providers: [
    GameGateway,
    { provide: SQLITE_DATABASE, useFactory: createSqlitePool },
    SqliteGameStore,
    { provide: GAME_STORE, useExisting: SqliteGameStore },
    { provide: GameService, useFactory: (store: SqliteGameStore) => new GameService(store), inject: [GAME_STORE] },
  ],
})
export class AppModule {}
