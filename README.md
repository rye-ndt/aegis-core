# Hexagonal Architecture Hello World API

A minimal TypeScript/Node.js project demonstrating **hexagonal architecture** (ports and adapters) following **clean architecture** principles by Uncle Bob.

## Quick Start

```bash
npm install
npm start
```

Test the API:
```bash
curl http://localhost:3000/api/greeting
curl http://localhost:3000/api/greeting/YourName
```

## Architecture

```
src/
├── domain/                    # Core business logic (no dependencies)
│   └── entities/
├── application/               # Use cases & ports (interfaces)
│   ├── ports/input/           # What the app CAN do
│   ├── ports/output/          # What the app NEEDS
│   └── use-cases/
├── infrastructure/            # Adapters (implementations)
│   ├── adapters/input/http/   # HTTP server & controllers
│   ├── adapters/output/       # Repositories
│   └── config/                # DI container
└── main.ts
```

## Key Principles

1. **Dependency Rule**: Dependencies point inward (Infrastructure → Application → Domain)
2. **Ports**: Interfaces that define boundaries
3. **Adapters**: Implementations of ports
4. **Zero Runtime Dependencies**: Uses only Node.js built-in `http` module

## Dependencies

Only dev dependencies:
- `typescript`
- `ts-node`
- `@types/node`
