#!/bin/bash
TOKEN="cfat_9jfGV7vxCTyeCo2eY80ltfx446Y4wBBApoQdnEFBc28f874d"
ACCOUNT="254301ba6b6323381932ddbca9608c73"
API="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT"

echo "Listing queues..."
QUEUES=$(curl -s -X GET "$API/workers/queues" -H "Authorization: Bearer $TOKEN")

echo "$QUEUES" | jq -c '.result[] | {queue_id: .queue_id, consumers: .consumers}' | while read row; do
  Q_ID=$(echo "$row" | jq -r '.queue_id')
  echo "$row" | jq -c '.consumers[] | .consumer_id' | while read consumer_id; do
    if [ -n "$consumer_id" ] && [ "$consumer_id" != "null" ]; then
        C_ID=$(echo "$consumer_id" | tr -d '"')
        echo "Deleting consumer $C_ID for queue $Q_ID..."
        curl -s -X DELETE "$API/workers/queues/$Q_ID/consumers/$C_ID" -H "Authorization: Bearer $TOKEN"
    fi
  done
done

echo "Deleting workers..."
curl -s -X DELETE "$API/workers/scripts/congress-trade" -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$API/workers/scripts/congress-trade-preview" -H "Authorization: Bearer $TOKEN"

echo "Deleting queues..."
echo "$QUEUES" | jq -c '.result[] | .queue_id' | while read q_id; do
  if [ -n "$q_id" ] && [ "$q_id" != "null" ]; then
      Q=$(echo "$q_id" | tr -d '"')
      echo "Deleting queue $Q..."
      curl -s -X DELETE "$API/workers/queues/$Q" -H "Authorization: Bearer $TOKEN"
  fi
done

