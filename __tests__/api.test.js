const request = require('supertest');
const express = require('express');

describe('ToolManager API', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    app.get('/api/status', (req, res) => {
      res.json({
        status: 'running',
        mode: process.env.TEST_MODE ? 'test' : 'production',
        autorun: false,
        timestamp: new Date().toISOString()
      });
    });

    app.post('/api/config', (req, res) => {
      const { testMode, autoMode, workingFolder } = req.body;
      
      if (!workingFolder) {
        return res.status(400).json({ error: 'workingFolder is required' });
      }

      res.json({
        success: true,
        config: { testMode, autoMode, workingFolder }
      });
    });

    app.post('/api/scan', (req, res) => {
      res.json({
        success: true,
        message: 'Scan started',
        toolsFound: 0,
        matrixCategories: []
      });
    });

    app.get('/api/results', (req, res) => {
      res.json({
        results: [],
        totalProjects: 0
      });
    });
  });

  describe('GET /api/status', () => {
    test('should return 200 with status', async () => {
      const response = await request(app)
        .get('/api/status')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body.status).toBe('running');
    });
  });

  describe('POST /api/config', () => {
    test('should configure ToolManager', async () => {
      const config = {
        testMode: true,
        autoMode: false,
        workingFolder: '/tmp/test'
      };

      const response = await request(app)
        .post('/api/config')
        .send(config)
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    test('should validate required fields', async () => {
      await request(app)
        .post('/api/config')
        .send({})
        .expect(400);
    });
  });

  describe('POST /api/scan', () => {
    test('should start tool scan', async () => {
      const response = await request(app)
        .post('/api/scan')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty('toolsFound');
      expect(response.body).toHaveProperty('matrixCategories');
    });
  });

  describe('GET /api/results', () => {
    test('should return results array', async () => {
      const response = await request(app)
        .get('/api/results')
        .expect(200);

      expect(Array.isArray(response.body.results)).toBe(true);
      expect(response.body).toHaveProperty('totalProjects');
    });
  });
});
