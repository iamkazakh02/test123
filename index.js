const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const cors = require('cors');
const Bottleneck = require('bottleneck');
const NodeCache = require('node-cache');

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize rate limiter
const limiter = new Bottleneck({
  minTime: 5000 // Minimum time between requests (5 seconds)
});

// Initialize cache
const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

const fetchWithRetry = async (url, headers, maxRetries = 5, baseDelay = 5000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get(url, { headers });
      return response;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const delay = baseDelay * Math.pow(2, i);
        console.log(`Rate limited. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error('Max retries reached');
};

const fetchProduct = limiter.wrap(async (searchTerm) => {
  const cacheKey = `product:${searchTerm}`;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) return cachedResult;

  const query = encodeURIComponent(searchTerm);
  const url = `https://kaspi.kz/yml/product-view/pl/filters?text=${query}&hint_chips_click=false&page=0&all=false&fl=true&ui=d&q=%3AavailableInZones%3AMagnum_ZONE1&i=-1&c=750000000`;

  const headers = {
    'Host': 'kaspi.kz',
    'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Accept': 'application/json, text/*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'X-KS-City': '750000000',
    'Connection': 'keep-alive',
    'Referer': `https://kaspi.kz/shop/search/?text=${query}&hint_chips_click=false`,
    'Cookie': 'ks.tg=71; k_stat=aa96833e-dac6-4558-a423-eacb2f0e53e4; kaspi.storefront.cookie.city=750000000',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  };

  try {
    const response = await fetchWithRetry(url, headers);
    if (response.headers['content-type'].includes('application/json')) {
      const products = response.data.data.cards.map(card => ({
        name: card.title,
        price: card.unitPrice,
        url: card.shopLink,
        image: card.previewImages[0]?.large || '',
        rating: card.rating,
        reviewCount: card.reviewsQuantity,
      }));
      cache.set(cacheKey, products);
      return products;
    } else {
      console.error('Non-JSON response received:', response.data);
      return [];
    }
  } catch (error) {
    console.error('Error fetching the JSON data:', error);
    return [];
  }
});

const findBestMatch = (searchTerm, products) => {
  if (products.length === 0) return null;

  const productNames = products.map(product => product.name);
  const { bestMatch } = stringSimilarity.findBestMatch(searchTerm, productNames);

  const bestMatchIndex = productNames.indexOf(bestMatch.target);
  return products[bestMatchIndex] || null;
};

app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, budget } = req.body;
    console.log('Received prompt:', prompt);
    console.log('Budget:', budget);

    const modelId = "gpt-4o";
    const systemPrompt = `You are an assistant helping to build PCs with a focus on speed, affordability, and reliability.
    Make a research on the prices of the components and components themselves in Kazakhstan.
    Look up the prices strictly in KZT.
    Suggest components that are commonly available and offer good value for money.
    Prefer newer, widely available models over older or niche products.
    IMPORTANT: Make a build that accurately or closely matches the desired budget of the user and DON'T comment on this. IMPORTANT: take the real-time prices of the components from kaspi.kz. 
    IMPORTANT: Dont write anything except JSON Format. STRICTLY list only the component names in JSON format, with each component type as a key and the component name as the value. DO NOT WRITE ANYTHING EXCEPT THE JSON. The response must include exactly these components: CPU, GPU, Motherboard, RAM, PSU, CPU Cooler, FAN, PC case. Use components that are most popular in Kazakhstan's stores in July 2024. Before answering, check the prices today in Kazakhstan.
    IMPORTANT: please dont send '''json {code} '''
    IMPORTANT: Please choose pricier gpu and cpu. Main budget should be focused on GPU.
    Example of the response:
    {
      "CPU": "AMD Ryzen 5 3600",
      "GPU": "Gigabyte GeForce GTX 1660 SUPER OC",
      "Motherboard": "Asus PRIME B450M-K",
      "RAM": "Corsair Vengeance LPX 16GB",
      "PSU": "EVGA 600 W1",
      "CPU Cooler": "Cooler Master Hyper 212",
      "FAN": "Noctua NF-P12",
      "PC case": "NZXT H510"
    }`;

    const currentMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${prompt} The budget for this build is ${budget} KZT.` }
    ];

    console.log('Sending messages to OpenAI:', currentMessages);

    const result = await openai.chat.completions.create({
      model: modelId,
      messages: currentMessages,
    });

    const responseText = result.choices[0].message.content;
    console.log('Received response from OpenAI: \n', responseText);

    let components;
    try {
      components = JSON.parse(responseText);
    } catch (error) {
      throw new Error('Failed to parse JSON response from OpenAI');
    }

    const requiredComponents = ["CPU", "GPU", "Motherboard", "RAM", "PSU", "CPU Cooler", "FAN", "PC case"];
    const componentKeys = Object.keys(components);

    if (!requiredComponents.every(comp => componentKeys.includes(comp))) {
      throw new Error('OpenAI response is missing one or more required components');
    }

    const queue = new Bottleneck({
      maxConcurrent: 1,
      minTime: 5000 // 5 seconds between requests
    });

    const fetchedProducts = await queue.schedule(() =>
      Promise.all(requiredComponents.map(async (key) => {
        const component = components[key];
        try {
          console.log(`Fetching products for component: ${component}`);
          const products = await fetchProduct(component);
          const bestMatchProduct = findBestMatch(component, products);
          console.log(`Best match product for ${component}:`, bestMatchProduct);
          return { key, product: bestMatchProduct };
        } catch (err) {
          console.error('Error fetching product:', component, err);
          return { key, product: null };
        }
      }))
    );

    const availableProducts = fetchedProducts.filter(({ product }) => product !== null);
    console.log('Available products after filtering:', availableProducts.length);

    const missingComponents = fetchedProducts
      .filter(({ product }) => product === null)
      .map(({ key }) => key);

    let productResponse = availableProducts.reduce((acc, { key, product }) => {
      if (product) {
        acc[key] = product;
      }
      return acc;
    }, {});

    // Calculate total price
    const totalPrice = Object.values(productResponse).reduce((sum, product) => sum + product.price, 0);

    // Send the response and return immediately if everything is okay
    if (missingComponents.length === 0 && Math.abs(totalPrice - budget) / budget <= 0.1) {
      res.send({ response: responseText, products: productResponse });
      return;
    }

    // If there are missing components or the total price is not within 10% of the budget, ask OpenAI for adjustments
    const componentsWithPrices = Object.entries(productResponse)
      .map(([key, product]) => `${key}: ${product.name} - ${product.price} KZT`)
      .join(', ');

    const adjustmentPrompt = `The following components were not found or the total price (${totalPrice} KZT) is not within 10% of the budget (${budget} KZT):
    ${missingComponents.join(', ')}. Current components and prices: ${componentsWithPrices}.
    Please suggest alternatives for the missing components and adjust the build to be closer to the budget while maintaining performance. STRICTLY: Provide your response in the same JSON format as before. Ensure the total cost does not exceed the budget and remains within 10% of the budget.
    And Also Please ensure that all components are real pc components because before parser could give me freezer or something random`;

    const adjustmentMessages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: adjustmentPrompt }
    ];

    const adjustmentResult = await openai.chat.completions.create({
      model: modelId,
      messages: adjustmentMessages,
    });

    const adjustedResponseText = adjustmentResult.choices[0].message.content;
    console.log('Received adjusted response from OpenAI: \n', adjustedResponseText);

    try {
      const adjustedComponents = JSON.parse(adjustedResponseText);

      const adjustedFetchedProducts = await queue.schedule(() =>
        Promise.all(
          Object.entries(adjustedComponents).map(async ([key, component]) => {
            if (typeof component === 'string') {
              try {
                console.log(`Fetching products for adjusted component: ${component}`);
                const products = await fetchProduct(component);
                const bestMatchProduct = findBestMatch(component, products);
                console.log(`Best match product for adjusted ${component}:`, bestMatchProduct);
                return { key, product: bestMatchProduct };
              } catch (err) {
                console.error('Error fetching adjusted product:', component, err);
                return { key, product: null };
              }
            }
            return { key, product: null };
          })
        )
      );

      adjustedFetchedProducts.forEach(({ key, product }) => {
        if (product) {
          productResponse[key] = product;
        }
      });

      res.send({ response: adjustedResponseText, products: productResponse });
      return;

    } catch (error) {
      console.error('Failed to parse adjusted JSON response from OpenAI:', error);
      res.status(500).json({ message: "Internal server error" });
      return;
    }

  } catch (err) {
    console.error('Error in generateResponse:', err);
    res.status(500).json({ message: "Internal server error" });
    return;
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
