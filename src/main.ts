import { depInjectConcrete } from './adapters/config';

const main = async (): Promise<void> => {
  const port = parseInt(process.env.PORT || '3000', 10);

  try {
    const server = depInjectConcrete.getHttpServer(port);
    await server.start();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}


process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

main();
