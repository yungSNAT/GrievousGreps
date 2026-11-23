/** Shared fixtures for the Terraform tests: a module tree beside a compose file, a Dockerfile and Kubernetes manifests. */

export const MAIN_TF = `resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = aws_iam_role.lambda.arn
  filename      = data.archive_file.api.output_path
  environment {
    variables = { TABLE = aws_dynamodb_table.orders.name, MODE = var.mode }
  }
}

data "archive_file" "api" {
  type        = "zip"
  source_dir  = "\${path.module}/../src/api"
  output_path = "\${path.module}/build/api.zip"
}

module "net" {
  source = "./modules/net"
  cidr   = local.cidr
}

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
}

resource "aws_ecs_task_definition" "web" {
  family                = "web"
  container_definitions = jsonencode([{ name = "web", image = "acme/web:1.2" }])
}

resource "aws_s3_object" "boot" {
  bucket  = module.net.bucket
  key     = "boot.sh"
  content = templatefile("\${path.module}/../scripts/boot.sh", { name = "x" })
}

resource "aws_iam_role_policy" "p" {
  role   = aws_iam_role.lambda.id
  policy = file(var.policy_path)
  other  = file("\${var.dir}/x.sh")
}
`;

/** Terraform files with the code, Dockerfile, compose file and manifests they sit beside. */
export const FIXTURE: Record<string, string> = {
  "infra/main.tf": MAIN_TF,
  "infra/iam.tf": `resource "aws_iam_role" "lambda" {\n  name = "lambda"\n}\n\nresource "aws_dynamodb_table" "orders" {\n  name = "orders"\n}\n`,
  "infra/modules/net/main.tf": `resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n`,
  "infra/modules/net/outputs.tf": `output "bucket" {\n  value = aws_s3_bucket.b.id\n}\n`,
  "src/api/handler.py": "def handler(event, context):\n    return 1\n",
  "src/api/util.py": "def helper():\n    return 2\n",
  "src/web/app.py": "def main():\n    return 3\n",
  "scripts/boot.sh": "#!/bin/sh\necho hi\n",
  "src/web/Dockerfile": "FROM python:3.12\nCOPY . /app\n",
  "compose.yaml": "services:\n  web: { build: src/web, image: acme/web }\n",
  "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec: { template: { metadata: { labels: { app: web } }, spec: { containers: [ { name: web, image: acme/web } ] } } }\n",
  "k8s/service.yaml": "apiVersion: v1\nkind: Service\nmetadata: { name: web }\nspec: { selector: { app: web } }\n",
};
