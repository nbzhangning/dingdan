#!/bin/bash
# 测试ERP接口的curl命令

# 测试数据
curl 'http://60.12.218.220:5030/receive_data' \
  -X POST \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "businessType":"DS01",
    "conno":"HBS-120260116047",
    "customid":"26794",
    "memo":"",
    "credate":"2026-01-16 00:00:00",
    "entryid":"2",
    "inputmanid":"11652",
    "assesscustomid":"7103",
    "detailList":[{
      "conno":"HBS-120260116047",
      "connodtlid":"2300018651600649",
      "goodsid":"2553",
      "goodsqty":"2",
      "dtlmemo":""
    }]
  }' \
  --compressed









