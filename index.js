const SQS = require('aws-sdk/clients/sqs');

class ServerlessOfflineSQS {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;

    this.commands = {};

    this.hooks = {
      'before:offline:start': this.offlineStartInit.bind(this),
      'before:offline:start:init': this.offlineStartInit.bind(this),
    };

    this.streams = [];
  }

  getSqsClientConfig() {
    const config = this.getCustomConfig();
    return {
      apiVersion: config.apiVersion,
      endpoint: config.endpoint,
      region: config.region,
    };
  }

  getCustomConfig() {
    return this.service.custom['serverless-offline-sqs'];
  }

  getFunctions() {
    return this.service.functions;
  }

  getSqsFunctionsNames() {
    const functions = this.getFunctions();
    return Object.keys(functions).filter((lambdaFunc) => functions[lambdaFunc].events.some((event) => Object.keys(event).indexOf('sqs') !== -1));
  }

  getSqsFunctions() {
    const functionsNames = this.getSqsFunctionsNames();
    const functions = this.getFunctions();
    return functionsNames.map((functionName) => functions[functionName]);
  }

  getFunctionHandlerPath(handler) {
    return `${this.serverless.config.servicePath}/${handler}`;
  }

  getQueuesFromResources() {
    const resources = this.service.resources.Resources;
    const resourcesNames = Object.keys(resources).filter((resource) => resources[resource].Type === 'AWS::SQS::Queue');
    return resourcesNames.map((resourceName) => resources[resourceName]);
  }

  getQueueName(arn) {
    if (typeof (arn) === 'string') return arn.split(':').pop();
    if (typeof (arn) === 'object' && arn['Fn::GetAtt']) {
      const resourceName = arn['Fn::GetAtt'][0];
      const sqsResource = this.service.resources.Resources[resourceName];
      if (
        (sqsResource.Type === 'AWS::SQS::Queue')
        && (sqsResource.Properties)
        && (sqsResource.Properties.QueueName)
      ) {
        return sqsResource.Properties.QueueName;
      }
      return '';
    }
    return '';
  }

  setSqsClient() {
    this.sqsClient = new SQS(this.getSqsClientConfig());
  }

  async getQueueUrl(queueName) {
    const response = await this.sqsClient.getQueueUrl({
      QueueName: queueName,
    }).promise();
    return response.QueueUrl;
  }

  getFuncQueueParams(func) {
    const handlerPath = this.getFunctionHandlerPath(func.handler);
    const { events } = func;
    const sqsEvents = events.filter((event) => Object.keys(event).filter((key) => key === 'sqs'));
    return sqsEvents.map((event) => {
      const { arn, batchSize } = event.sqs;
      const queueName = this.getQueueName(arn);
      return {
        batchSize: batchSize || 10,
        arn,
        queueName,
        handlerPath,
      };
    });
  }

  async createQueue(queueName, isFifo, contentBasedDeduplication) {
    const params = {
      QueueName: queueName,
      Attributes: {},
    };
    if (isFifo) params.Attributes.FifoQueue = 'true';
    if (isFifo && contentBasedDeduplication) params.Attributes.ContentBasedDeduplication = 'true';
    if (isFifo && !contentBasedDeduplication) params.Attributes.ContentBasedDeduplication = 'false';
    return this.sqsClient.createQueue(params).promise();
  }

  async createQueues(queues) {
    const queue = queues.shift();
    const queueName = queue && queue.Properties && queue.Properties.QueueName;
    const isFifo = queue
      && queue.Properties
      && queue.Properties.FifoQueue;
    const contentBasedDeduplication = queue
      && queue.Properties
      && queue.Properties.ContentBasedDeduplication;
    await this.createQueue(queueName, isFifo, contentBasedDeduplication);
    if (queues.length > 0) return this.createQueues(queues);
    return 'Done';
  }

  invokeHandlerWithEvent(queue, messages) {
    const eventSourceARN = typeof queue.arn === 'string'
      ? queue.arn
      : `arn:aws:sqs:${this.getCustomConfig().region || 'eu-west-1'}:000000000000:${queue.queueName}`;

    const event = {
      Records: messages.map(
        ({
          MessageId: messageId,
          ReceiptHandle: receiptHandle,
          Body: body,
          Attributes: attributes,
          MessageAttributes: messageAttributes,
          MD5OfBody: md5OfBody,
        }) => ({
          messageId,
          receiptHandle,
          body,
          attributes,
          messageAttributes,
          md5OfBody,
          eventSource: 'aws:sqs',
          eventSourceARN,
          awsRegion: this.getCustomConfig().region || 'eu-est-1',
        }),
      ),
    };

    const { handlerPath } = queue;
    const handlerNormalizedPathSplit = handlerPath.split('.');
    const functionName = handlerNormalizedPathSplit.pop();
    const handlerPathJoined = handlerNormalizedPathSplit.join();
    // eslint-disable-next-line
    const handler = require(handlerPathJoined)[functionName];
    handler(event);
  }

  async deleteMessageBatch(messages, queueUrl) {
    return this.sqsClient.deleteMessageBatch({
      Entries: (messages || []).map(({ MessageId: Id, ReceiptHandle }) => ({
        Id,
        ReceiptHandle,
      })),
      QueueUrl: queueUrl,
    }).promise();
  }

  async receiveMessageLoop(queue) {
    const { batchSize } = queue;
    const { endpoint } = this.getCustomConfig();

    const dockerQueueUrl = queue.queueUrl.replace(/https?:\/\/(.*):(?<!\d)(?!0000)\d{4}(?!\d)/, endpoint);

    const params = {
      QueueUrl: dockerQueueUrl,
      MaxNumberOfMessages: batchSize,
      AttributeNames: ['ALL'],
      MessageAttributeNames: ['ALL'],
      WaitTimeSeconds: 10,
    };

    const { Messages: messages } = await this.sqsClient.receiveMessage(params).promise();
    if (messages) this.invokeHandlerWithEvent(queue, messages);

    // if (messages) await this.deleteMessageBatch(messages, queueUrl);

    this.receiveMessageLoop(queue);
  }

  async getQueueParamsFromFunctions(functions) {
    const func = functions.shift();
    const queuesParams = this.getFuncQueueParams(func);
    const queueUrlsPromises = queuesParams.map((queue) => this.getQueueUrl(queue.queueName));
    const results = await Promise.allSettled(queueUrlsPromises);
    const queueUrls = results.filter((result) => result.status === 'fulfilled').map((url) => url.value);
    const rejected = queuesParams.filter((queue) => !queueUrls.map((url) => url.split('/').pop()).includes(queue.queueName));

    rejected.forEach((rejectedQueue) => this.serverless.cli.log(`
      serverless-offline-sqs: [ERROR] Hey! Listen! Your queue with name "${rejectedQueue.queueName}" is not created.
      Either list it in Resources and set "autoCreate" to true or create it manually in elasticmq.
      I'm going to ignore it for the moment and you won't receive any messages.`));

    const queuesObjects = [];
    queuesParams.forEach((queue) => {
      queueUrls.forEach((url) => {
        if (url.split('/').pop() === queue.queueName) {
          queuesObjects.push({
            ...queue,
            queueUrl: url,
          });
        }
      });
    });

    return queuesObjects;
  }

  async offlineStartInit() {
    this.setSqsClient();
    try {
      const queues = this.getQueuesFromResources();
      const { autoCreate } = this.getCustomConfig();
      if (autoCreate) await this.createQueues(queues);
      const functions = this.getSqsFunctions();
      const queuesParams = await this.getQueueParamsFromFunctions(functions);
      queuesParams.forEach((queue) => this.receiveMessageLoop(queue));
    } catch (e) {
      console.error(`Error in serverless-offline-sqs module: ' ${JSON.stringify(e, null, 2)}`);
    }
  }
}

module.exports = ServerlessOfflineSQS;
