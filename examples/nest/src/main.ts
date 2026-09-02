import 'reflect-metadata';
import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiOperation, ApiTags, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { setupLudin } from '@ludin/nestjs';

@ApiTags('Users')
@Controller('users')
class UsersController {
  @Get()
  @ApiOperation({ summary: 'List users' })
  list(@Query('limit') limit?: string) {
    return [{ id: 1, name: 'Minyong' }, { id: 2, name: 'Jane' }].slice(0, Number(limit) || 10);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user' })
  one(@Param('id') id: string) {
    return { id: Number(id), name: 'Minyong' };
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Exactly like SwaggerModule.setup – but with login, roles and IP rules.
  const config = new DocumentBuilder().setTitle('Nest demo').setVersion('1.0').addBearerAuth().build();
  const document = SwaggerModule.createDocument(app, config);
  setupLudin(app, '/docs', document, {
    auth: {
      users: [{ email: 'admin@example.com', password: process.env.LUDIN_ADMIN_PW ?? 'admin', role: 'admin' }],
      session: { secret: process.env.LUDIN_SESSION_SECRET ?? 'dev-only-secret' },
    },
    theme: { title: 'Nest demo', primary: '#e0234e' },
  });

  await app.listen(3001);
  console.log('▶ http://localhost:3001/docs');
}
bootstrap();
