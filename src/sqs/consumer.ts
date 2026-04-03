import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';

const WAIT_TIME_SECONDS = 20;
const MAX_MESSAGES = 5;
const VISIBILITY_TIMEOUT_SECONDS = 2700; // 45 minutes — covers full stage + buffer

export class SqsConsumer {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    region: string,
  ) {
    this.client = new SQSClient({ region });
  }

  async pollBatch(): Promise<Message[]> {
    const command = new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      WaitTimeSeconds: WAIT_TIME_SECONDS,
      MaxNumberOfMessages: MAX_MESSAGES,
      VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      MessageAttributeNames: ['All'],
    });

    const response = await this.client.send(command);
    return response.Messages || [];
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    const command = new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: receiptHandle,
    });

    await this.client.send(command);
  }
}
