#!/bin/bash
FILE=$1
# Extract relative path (chamber/year/docId.pdf)
REL_PATH=$(echo "$FILE" | sed 's|.*/scratch/raw-pdfs/||')
npx wrangler r2 object put "congress-trade-bucket/raw-pdfs/$REL_PATH" --file "$FILE" > /dev/null 2>&1
echo "Uploaded $REL_PATH"
