import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import { compilerOptions } from './tsconfig.json';

const moduleNameMapper = pathsToModuleNameMapper(compilerOptions.paths, {
  prefix: '<rootDir>/',
});

const tsJest: Config['transform'] = {
  '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
};

const config: Config = {
  rootDir: '.',
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      transform: tsJest,
      moduleNameMapper,
      moduleFileExtensions: ['ts', 'js', 'json'],
      setupFilesAfterEnv: ['<rootDir>/test/setup-unit.ts'],
      clearMocks: true,
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
      transform: tsJest,
      moduleNameMapper,
      moduleFileExtensions: ['ts', 'js', 'json'],
      setupFilesAfterEnv: ['<rootDir>/test/setup-integration.ts'],
      clearMocks: true,
    },
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/**/index.ts',
    '!src/**/*.dto.ts',
    '!src/**/*.response.ts',
    '!src/**/*.d.ts',
    // Configuracion declarativa de Swagger: mismo caso que los .module.ts, cubrirla
    // inflaria la cifra sin anadir confianza.
    '!src/shared/infrastructure/http/openapi.ts',
    '!src/shared/infrastructure/persistence/prisma/generated/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
  },
};

export default config;
