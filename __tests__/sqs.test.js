const SQS = require('aws-sdk/clients/sqs');
const ServerlessOfflineSQS = require('../index.js');

const message = {
  messageId: '048b40b2-ae41-45d7-98af-965942fb43ec',
  receiptHandle: '048b40b2-ae41-45d7-98af-965942fb43ec#a2a1ac04-e86e-49d0-a96d-085da6e4ef74',
  body: 'Information about current NY Times fiction bestseller for week of 12/11/2016.',
  attributes: undefined,
  messageAttributes: undefined,
  md5OfBody: 'bbdc5fdb8be7251f5c910905db994bab',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:eu-west-1:000000000000:queue1',
  awsRegion: 'eu-west-1',
};

const arn = 'arn:aws:sqs:eu-west-1:000000000000:queue1';
const objectArn = {
  'Fn::GetAtt': [
    'Queue1',
    'Arn',
  ],
};

const serverless = {
  cli: {
    log: function(message) {
      return console.log(message);
    },
  },
  config: {
    servicePath: '/mock'
  },
  service: {
    custom: {
      'serverless-offline-sqs': {
        autoCreate: true,
        apiVersion: '2012-11-05',
        endpoint: 'http://elasticmq:9324',
        region: 'eu-west-1',
      },
    },
    functions: {
      "test_sqs": {
        "handler": "functions/test/handler.test",
        "events": [
          {
            "sqs": {
              "arn": {
                "Fn::GetAtt": [
                  "Queue1",
                  "Arn"
                ]
              },
              "batchSize": 10
            }
          },
          {
            "sqs": {
              "arn": "arn:aws:sqs:us-east-2:444455556666:queuewithoutresource"
            }
          }
        ]
      }
    },
    resources: {
      "Resources": {
        "Queue1": {
          "Type": "AWS::SQS::Queue",
          "Properties": {
            "QueueName": "queue1"
          }
        }
      }
    },
  },
};

ServerlessOfflineSQS.prototype.hooks = jest.fn();

it('getCustomConfig should return the config', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const config = serverlessOffline.getCustomConfig();
  expect(config).toEqual(serverless.service.custom['serverless-offline-sqs']);
});

it('getSqsClientConfig should return the config', () => {
  const expectedConfig = {
    apiVersion: '2012-11-05',
    endpoint: 'http://elasticmq:9324',
    region: 'eu-west-1',
  };
 
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const config = serverlessOffline.getSqsClientConfig();
  expect(config).toEqual(expectedConfig);
});

it('getFunctions should return the functions', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const config = serverlessOffline.getFunctions();
  expect(config).toEqual(serverless.service.functions);
});

it('getSqsFunctionsNames should return functions names', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const functionNames = serverlessOffline.getSqsFunctionsNames();
  const expected = ['test_sqs'];
  expect(functionNames).toEqual(expected);
});

it('getSqsFunctions should return the functions', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const functionsNames = serverlessOffline.getSqsFunctionsNames();
  const functions = serverlessOffline.getSqsFunctions();
  const expected = functionsNames.map((functionName) => serverless.service.functions[functionName]);
  expect(functions).toEqual(expected);
});

it('getFunctionHandlerPath should return the function handler path', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const handler = serverless.service.functions['test_sqs'].handler;
  const handlerPath = serverlessOffline.getFunctionHandlerPath(handler);
  expect(handlerPath).toEqual(`/mock/${handler}`);
});

it('getQueuesFromResources should return queues from resources block', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const resources = serverless.service.resources.Resources;
  const resourcesNames = Object.keys(resources).filter((resource) => resources[resource].Type === 'AWS::SQS::Queue');
  const expectedQueues = resourcesNames.map((resourceName) => resources[resourceName]);
  const queues = serverlessOffline.getQueuesFromResources();
  expect(queues).toEqual(expectedQueues);
});

it('getQueueName should return queueNames from arn', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const name = serverlessOffline.getQueueName(arn);
  expect(name).toEqual('queue1');
  const objectName = serverlessOffline.getQueueName(objectArn);
  expect(objectName).toEqual('queue1');
});

it('setSqsClient should return an instance of SQS', () => {
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  serverlessOffline.setSqsClient();
  expect(serverlessOffline.sqsClient).toBeInstanceOf(SQS);
});

it('getQueueUrl should return queue URL', async () => {
  jest.mock('../index.js');
  const expectedQueueUrl = 'http://0.0.0.0/queue/queue1';
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const mockGetQueueUrl = jest.fn();
  ServerlessOfflineSQS.prototype.getQueueUrl = mockGetQueueUrl;
  mockGetQueueUrl.mockReturnValue(Promise.resolve(expectedQueueUrl));
  const url = await serverlessOffline.getQueueUrl('queue1');
  expect(url).toEqual(expectedQueueUrl);
});

it('getFuncQueueParams should return queue params', () => {
  const func = serverless.service.functions['test_sqs'];
  const expectedParams = [
    {
      batchSize: func.batchSize || 10,
      arn: func.events[0].sqs.arn,
      queueName: 'queue1',
      handlerPath: '/mock/functions/test/handler.test'
    },
    {
      batchSize: func.batchSize || 10,
      arn: func.events[1].sqs.arn,
      queueName: 'queuewithoutresource',
      handlerPath: '/mock/functions/test/handler.test'
    }
  ];
  const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
  const params = serverlessOffline.getFuncQueueParams(func);
  expect(params).toEqual(expectedParams);
});

// it('createQueues should return successful', async () => {
//   jest.mock('../index.js');
//   const mockCreateQueue = jest.fn();
//   const serverlessOffline = new ServerlessOfflineSQS(serverless, {});
//   serverlessOffline.setSqsClient();
//   serverlessOffline.sqsClient.createQueue = mockCreateQueue;
//   serverlessOffline.sqsClient.createQueue.promise = mockCreateQueue;
//   mockCreateQueue.mockReturnValue(Promise.resolve('Done'));
//   const queues = [serverless.service.resources.Resources['Queue1']];
//   const returnValue = await serverlessOffline.createQueues(queues);
//   expect(returnValue).toEqual('Done');
// });
