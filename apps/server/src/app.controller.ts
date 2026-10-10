import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class AppController {
  @Get()
  health(): { status: "ok"; service: "grudge-vault-api" } {
    return { status: "ok", service: "grudge-vault-api" };
  }
}
