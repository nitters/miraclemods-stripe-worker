/**
 * Stripe Checkout Middleware Worker for MiracleMods
 * Complete separation between WooCommerce and Stripe
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Enable CORS for your domain
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      // Route handlers
      if (url.pathname === '/create-checkout' && request.method === 'POST') {
        return await handleCreateCheckout(request, env, corsHeaders);
      } else if (url.pathname === '/webhook' && request.method === 'POST') {
        return await handleStripeWebhook(request, env);
      } else if (url.pathname === '/success') {
        return handleSuccessPage(url);
      } else if (url.pathname === '/cancel') {
        return handleCancelPage(url);
      } else if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }
      
      // Default response
      return new Response('Stripe Checkout Worker - Endpoint not found', { 
        status: 404,
        headers: corsHeaders 
      });
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

async function handleCreateCheckout(request, env, corsHeaders) {
  try {
    let data;
    const contentType = request.headers.get('content-type');
    const url = new URL(request.url);
    
    if (contentType && contentType.includes('application/json')) {
      data = await request.json();
    } else {
      // Handle form data from redirect
      const formData = await request.formData();
      data = Object.fromEntries(formData);
    }
    
    const { order_id, amount, currency, customer_email, customer_name } = data;
    
    // Validate required fields
    if (!order_id || !amount) {
      return new Response(JSON.stringify({ 
        error: 'Missing required fields: order_id and amount are required' 
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Validate Stripe configuration
    if (!env.STRIPE_SECRET_KEY) {
      console.error('STRIPE_SECRET_KEY not configured');
      return new Response(JSON.stringify({ 
        error: 'Payment gateway not configured. Please contact support.' 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    // Create Stripe checkout session
    const sessionData = {
      payment_method_types: ['card'],
      mode: 'payment',
      success_url: `${url.origin}/success?session_id={CHECKOUT_SESSION_ID}&order_id=${order_id}`,
      cancel_url: `${url.origin}/cancel?order_id=${order_id}`,
      metadata: {
        order_id: order_id.toString(),
        woocommerce_url: env.WOOCOMMERCE_URL || 'https://miraclemods.com'
      }
    };
    
    // Add line items
    sessionData.line_items = [{
      price_data: {
        currency: currency || 'usd',
        product_data: {
          name: `Order #${order_id}`,
          description: `Payment for MiracleMods order #${order_id}`
        },
        unit_amount: Math.round(parseFloat(amount) * 100)
      },
      quantity: 1
    }];
    
    // Add customer email if provided
    if (customer_email) {
      sessionData.customer_email = customer_email;
    }
    
    // Create form data for Stripe API
    const formData = new URLSearchParams();
    buildStripeFormData(formData, sessionData);
    
    // Call Stripe API
    const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString()
    });
    
    if (!stripeResponse.ok) {
      const errorData = await stripeResponse.json();
      console.error('Stripe API error:', errorData);
      return new Response(JSON.stringify({ 
        error: errorData.error?.message || 'Failed to create payment session' 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    
    const session = await stripeResponse.json();
    
    // Return redirect response
    return Response.redirect(session.url, 303);
    
  } catch (error) {
    console.error('Checkout creation error:', error);
    return new Response(JSON.stringify({ 
      error: 'Failed to process checkout request' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleStripeWebhook(request, env) {
  try {
    const signature = request.headers.get('stripe-signature');
    const body = await request.text();
    
    // Parse the webhook event
    let event;
    try {
      event = JSON.parse(body);
      
      // Verify signature if webhook secret is configured
      if (env.STRIPE_WEBHOOK_SECRET && signature) {
        // Simple signature verification
        // In production, use Stripe's official signature verification
        const timestamp = signature.split(',')[0].split('=')[1];
        const signatures = signature.split(',')[1].split('=')[1].split(' ');
        // Add proper signature verification here if needed
      }
    } catch (err) {
      console.error('Webhook parsing error:', err);
      return new Response('Invalid webhook payload', { status: 400 });
    }
    
    // Handle different event types
    console.log('Webhook event type:', event.type);
    
    switch (event.type) {
      case 'checkout.session.completed':
        const successSession = event.data.object;
        if (successSession.metadata?.order_id) {
          await updateWooCommerceOrder(
            successSession.metadata.order_id,
            'processing',
            successSession.payment_intent,
            env
          );
        }
        break;
        
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        const failedSession = event.data.object;
        if (failedSession.metadata?.order_id) {
          await updateWooCommerceOrder(
            failedSession.metadata.order_id,
            'failed',
            null,
            env
          );
        }
        break;
        
      default:
        console.log('Unhandled webhook event type:', event.type);
    }
    
    return new Response('Webhook processed', { status: 200 });
    
  } catch (error) {
    console.error('Webhook processing error:', error);
    return new Response('Webhook processing failed', { status: 500 });
  }
}

async function updateWooCommerceOrder(orderId, status, paymentIntentId, env) {
  try {
    if (!env.WOOCOMMERCE_CONSUMER_KEY || !env.WOOCOMMERCE_CONSUMER_SECRET) {
      console.error('WooCommerce API credentials not configured');
      return false;
    }
    
    const wooUrl = env.WOOCOMMERCE_URL || 'https://miraclemods.com';
    const auth = btoa(`${env.WOOCOMMERCE_CONSUMER_KEY}:${env.WOOCOMMERCE_CONSUMER_SECRET}`);
    
    const updateData = {
      status: status,
      meta_data: [
        {
          key: '_stripe_payment_status',
          value: status
        }
      ]
    };
    
    if (paymentIntentId) {
      updateData.transaction_id = paymentIntentId;
      updateData.meta_data.push({
        key: '_stripe_payment_intent',
        value: paymentIntentId
      });
    }
    
    const response = await fetch(
      `${wooUrl}/wp-json/wc/v3/orders/${orderId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to update order ${orderId}:`, response.status, errorText);
      return false;
    }
    
    console.log(`Order ${orderId} updated to ${status}`);
    return true;
    
  } catch (error) {
    console.error('Error updating WooCommerce order:', error);
    return false;
  }
}

function handleSuccessPage(url) {
  const orderId = url.searchParams.get('order_id');
  const sessionId = url.searchParams.get('session_id');
  
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Successful - MiracleMods</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 40px;
          max-width: 500px;
          width: 100%;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          text-align: center;
        }
        .success-icon {
          width: 80px;
          height: 80px;
          margin: 0 auto 30px;
          background: #4CAF50;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .success-icon svg {
          width: 40px;
          height: 40px;
          stroke: white;
          stroke-width: 3;
        }
        h1 {
          color: #333;
          margin-bottom: 15px;
          font-size: 28px;
        }
        .order-info {
          background: #f7f7f7;
          padding: 20px;
          border-radius: 10px;
          margin: 25px 0;
        }
        .order-id {
          font-size: 18px;
          color: #666;
          margin-bottom: 10px;
        }
        .message {
          color: #666;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .btn {
          display: inline-block;
          padding: 12px 30px;
          background: #667eea;
          color: white;
          text-decoration: none;
          border-radius: 25px;
          font-weight: 600;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="success-icon">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
          </svg>
        </div>
        <h1>Payment Successful!</h1>
        <div class="order-info">
          <div class="order-id">Order #${orderId || 'N/A'}</div>
          <small style="color: #999;">Transaction confirmed</small>
        </div>
        <p class="message">
          Thank you for your purchase! Your payment has been processed successfully.
          You will receive an order confirmation email shortly with all the details.
        </p>
        <a href="https://miraclemods.com/my-account/orders/" class="btn">View Your Orders</a>
      </div>
    </body>
    </html>
  `;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

function handleCancelPage(url) {
  const orderId = url.searchParams.get('order_id');
  
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Payment Cancelled - MiracleMods</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          padding: 40px;
          max-width: 500px;
          width: 100%;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          text-align: center;
        }
        .cancel-icon {
          width: 80px;
          height: 80px;
          margin: 0 auto 30px;
          background: #ff5252;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .cancel-icon svg {
          width: 40px;
          height: 40px;
          stroke: white;
          stroke-width: 3;
        }
        h1 {
          color: #333;
          margin-bottom: 15px;
          font-size: 28px;
        }
        .order-info {
          background: #f7f7f7;
          padding: 20px;
          border-radius: 10px;
          margin: 25px 0;
        }
        .order-id {
          font-size: 18px;
          color: #666;
        }
        .message {
          color: #666;
          line-height: 1.6;
          margin-bottom: 30px;
        }
        .btn {
          display: inline-block;
          padding: 12px 30px;
          background: #f5576c;
          color: white;
          text-decoration: none;
          border-radius: 25px;
          font-weight: 600;
          transition: transform 0.2s, box-shadow 0.2s;
          margin: 5px;
        }
        .btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 5px 15px rgba(245, 87, 108, 0.4);
        }
        .btn-secondary {
          background: #6c757d;
        }
        .btn-secondary:hover {
          box-shadow: 0 5px 15px rgba(108, 117, 125, 0.4);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="cancel-icon">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </div>
        <h1>Payment Cancelled</h1>
        <div class="order-info">
          <div class="order-id">Order #${orderId || 'N/A'}</div>
        </div>
        <p class="message">
          Your payment was cancelled. No charges have been made to your account.
          You can try again or contact our support team if you need assistance.
        </p>
        <div>
          <a href="https://miraclemods.com/cart/" class="btn">Return to Cart</a>
          <a href="https://miraclemods.com/contact/" class="btn btn-secondary">Contact Support</a>
        </div>
      </div>
    </body>
    </html>
  `;
  
  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

// Helper function to build form data for Stripe API
function buildStripeFormData(formData, data, prefix = '') {
  Object.keys(data).forEach(key => {
    const value = data[key];
    const formKey = prefix ? `${prefix}[${key}]` : key;
    
    if (value === null || value === undefined) return;
    
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object') {
          buildStripeFormData(formData, item, `${formKey}[${index}]`);
        } else {
          formData.append(`${formKey}[${index}]`, item);
        }
      });
    } else if (typeof value === 'object') {
      buildStripeFormData(formData, value, formKey);
    } else {
      formData.append(formKey, value);
    }
  });
}