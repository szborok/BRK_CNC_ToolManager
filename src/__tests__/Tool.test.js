const Tool = require('../Tool');

describe('Tool', () => {
  describe('constructor', () => {
    test('should create tool with valid data', () => {
      const tool = new Tool('RT-8400300', 5.7, null, {
        description: 'E-Cut tool'
      });

      expect(tool.matrixCode).toBe('RT-8400300');
      expect(tool.diameter).toBe(5.7);
      expect(tool.description).toBe('E-Cut tool');
    });

    test('should handle missing optional fields', () => {
      const tool = new Tool('RT-8400300');

      expect(tool.matrixCode).toBe('RT-8400300');
      expect(tool.diameter).toBeNull();
    });

    test('should have tool identity extracted', () => {
      const tool = new Tool('RT-8400300', 5.7);
      
      expect(tool.toolIdentity).toBeDefined();
    });
  });

  describe('validation', () => {
    test('should create tool with correct matrix code', () => {
      const tool = new Tool('RT-8400300');
      expect(tool.matrixCode).toBe('RT-8400300');
    });

    test('should handle tool with variant suffix', () => {
      const tool = new Tool('RT-8400300_1');
      expect(tool.matrixCode).toBe('RT-8400300_1');
    });
  });

  describe('state management', () => {
    test('should initialize with FREE state', () => {
      const tool = new Tool('RT-8400300');
      const ToolState = require('../../utils/ToolState');
      expect(tool.toolState).toBe(ToolState.FREE);
    });

    test('should track usage history', () => {
      const tool = new Tool('RT-8400300');
      expect(Array.isArray(tool.usageHistory)).toBe(true);
      expect(tool.usageHistory.length).toBe(0);
    });

    test('should track project list', () => {
      const tool = new Tool('RT-8400300');
      expect(Array.isArray(tool.projectList)).toBe(true);
    });
  });
});
